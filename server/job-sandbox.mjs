// What a generation job is allowed to touch. Enforced by the kernel through
// scripts/sandbox/sandbox-exec.py (Landlock + seccomp) inside a `systemd-run --user` unit
// (memory, tasks, CPU, wall clock). The job's tools are also narrowed in buildArgv, but
// these rules hold even if a model is steered past those.
//
// Why --user and no root: the service runs with NoNewPrivileges, so sudo can't work from
// it, and mount-namespace options are silently ignored by the user manager. Don't add
// InaccessiblePaths & co here expecting them to do anything.
import { spawn as nodeSpawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const SYSTEM_EXEC = ['/usr', '/bin', '/lib', '/lib64', '/sbin'];
const SYSTEM_READ = [
  '/etc/ssl', '/etc/ca-certificates', '/etc/resolv.conf', '/etc/hosts', '/etc/passwd', '/etc/group',
  '/etc/nsswitch.conf', '/etc/localtime', '/etc/ld.so.cache', '/etc/bash.bashrc', '/etc/inputrc',
  // Not /proc itself: other processes' command lines live there.
  '/proc/meminfo', '/proc/cpuinfo', '/proc/stat', '/proc/uptime', '/proc/loadavg', '/proc/version',
  '/sys/devices/system/cpu',
];
const DEVICES = ['/dev/null', '/dev/zero', '/dev/urandom', '/dev/random', '/dev/full', '/dev/tty'];
// Everything generation reads from the checkout. An allowlist, so .env, .git, data/jobs
// and whatever gets added later stay out.
const REPO_READ = [
  '.claude/skills', 'scripts', 'shared', 'palettes', 'node_modules', 'src', 'package.json',
  'STRUDEL_GUIDE.md', 'STEMS_GUIDE.md', 'KIT_GUIDE.md', 'README.md',
  'data/banks.json', 'data/kit-lessons', 'data/sample-cache',
];

const flags = (flag, paths) => paths.flatMap((p) => [flag, p]);
const helperPath = (repoRoot) => join(repoRoot, 'scripts', 'sandbox', 'sandbox-exec.py');

export function agentSandboxFlags({ repoRoot, jobDir, proxyPort, claudeDir, envFile }) {
  return [
    ...flags('--rox', [...SYSTEM_EXEC, claudeDir]),
    ...flags('--ro', [...SYSTEM_READ, ...REPO_READ.map((p) => join(repoRoot, p))]),
    ...flags('--rw', [...DEVICES, join(repoRoot, 'staging')]),
    ...flags('--rw-links', [jobDir]), // private scratch: claude keeps symlinks in its config
    '--tcp', String(proxyPort), // the broker: API proxy + save/read ops. Nothing else.
    '--env-file', envFile,
  ];
}

// Separate workers, never one process doing two of these. An evaluator runs agent-written
// code, so assume it is arbitrary code: no network, and it can write only its own scratch. A
// fetcher gets it the sample manifests it names. A publisher writes where a save lands (the
// server serves one of those trees). Neither of those two evaluates agent code.
export function workerSandboxFlags({ repoRoot, tmpDir, publishes = false, network = publishes }) {
  const landing = publishes ? [join(repoRoot, 'data', 'sample-cache'), join(repoRoot, 'palettes')] : [];
  return [
    ...flags('--rox', SYSTEM_EXEC),
    ...flags('--ro', [...SYSTEM_READ, ...REPO_READ.map((p) => join(repoRoot, p))]),
    ...flags('--rw', [...DEVICES, tmpDir, ...landing]),
    ...(network ? ['--tcp', '443', '--allow-udp'] : []), // UDP: DNS
  ];
}

// Exactly what the agent's process tree sees. Built from nothing, never from process.env.
export function agentEnv({ jobId, jobDir, proxyPort, brokerToken, oauthToken }) {
  const proxy = `http://127.0.0.1:${proxyPort}`;
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: join(jobDir, 'home'),
    TMPDIR: join(jobDir, 'tmp'),
    USER: 'builder',
    LANG: 'C.UTF-8',
    NODE_ENV: 'production',
    CLAUDE_CONFIG_DIR: join(jobDir, 'config'),
    CLAUDE_CODE_OAUTH_TOKEN: oauthToken, // access token only; the refresh token stays out
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    HTTPS_PROXY: proxy,
    https_proxy: proxy,
    NO_PROXY: '127.0.0.1',
    CRATE_JOB_ID: jobId,
    CRATE_BROKER_URL: proxy,
    CRATE_BROKER_TOKEN: brokerToken,
  };
}

export const JOB_LIMITS = { MemoryMax: '10G', TasksMax: '2048', CPUQuota: '350%', RuntimeMaxSec: '3600' };
export const WORKER_LIMITS = { MemoryMax: '1500M', TasksMax: '256', CPUQuota: '100%', RuntimeMaxSec: '180' };
export const PUBLISHER_LIMITS = { ...WORKER_LIMITS, RuntimeMaxSec: '600' }; // vendoring a large bank
// Each worker is its own unit, outside its job's limits. On 4 cores shared with other services.
export const MAX_CONCURRENT_WORKERS = 3;

export function systemdRunArgv({ unit, limits, cwd, command }) {
  return [
    '--user', '--wait', '--pipe', '--collect', '--quiet',
    // Otherwise the manager expands ${VAR} from its own environment, in the job's prompt too.
    '--expand-environment=no',
    `--unit=${unit}`, `--working-directory=${cwd}`,
    ...Object.entries(limits).flatMap(([k, v]) => ['-p', `${k}=${v}`]),
    ...command,
  ];
}

const uid = () => process.getuid?.() ?? 1000;
export const systemdEnv = () => ({ PATH: process.env.PATH, XDG_RUNTIME_DIR: `/run/user/${uid()}` });

// Current OAuth access token. The refresh token is never copied anywhere: the file stays
// under the login's control, refreshed by whichever claude notices it's about to expire.
export const oauthPath = () => join(process.env.HOME ?? '', '.claude', '.credentials.json');
export async function readOauth(path = oauthPath()) {
  const { accessToken, expiresAt } = JSON.parse(await readFile(path, 'utf8')).claudeAiOauth ?? {};
  return { accessToken, expiresAt };
}

const REFRESH_WINDOW_MS = 5 * 60 * 1000; // claude refreshes only this close to expiry
const MIN_JOB_MS = 60 * 60 * 1000; // a job can't refresh: the token must outlast it (RuntimeMaxSec)

// Resolves with a token good for a whole job. Holds the job while the token is too short to
// use and too long for claude to refresh, then has a fixed, input-free claude call refresh it.
export async function freshOauthToken({
  read = readOauth,
  refresh,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
} = {}) {
  for (let i = 0; i < 90; i++) {
    const { accessToken, expiresAt } = await read();
    const left = expiresAt - now();
    if (accessToken && left > MIN_JOB_MS) return accessToken;
    if (left <= REFRESH_WINDOW_MS) await refresh();
    else await sleep(60 * 1000);
  }
  throw new Error('claude login could not be refreshed');
}

// Cheapest call that makes claude check its login. Fixed prompt, no tools, no job input.
export function refreshOauthWithClaude({ spawn = nodeSpawn, cwd = '/' } = {}) {
  return new Promise((resolve) => {
    const child = spawn('claude', [
      '-p', 'ok', '--model', 'haiku', '--tools', '', '--max-budget-usd', '0.05',
      '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence',
    ], {
      cwd,
      stdio: 'ignore',
      env: { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
    });
    child.on('error', () => resolve());
    child.on('close', () => resolve());
  });
}

const claudeBinary = () => realpathSync(join(process.env.HOME ?? '', '.local', 'bin', 'claude'));

// The launcher the runner uses. Returns spawn arguments and a cleanup for one job.
export function createJobLauncher({ repoRoot, broker, getToken = () => freshOauthToken({ refresh: () => refreshOauthWithClaude({ cwd: repoRoot }) }) }) {
  return async function launch(job, authorProfileId, claudeArgs) {
    const oauthToken = await getToken();
    const jobDir = join(repoRoot, 'data', 'job-sandbox', job.id);
    for (const d of ['home', 'tmp', 'config']) await mkdir(join(jobDir, d), { recursive: true });
    await mkdir(join(repoRoot, 'staging'), { recursive: true });

    const brokerToken = broker.register(job, authorProfileId);
    const proxyPort = broker.port();
    const envFile = join(jobDir, 'env.json');
    await writeFile(envFile, JSON.stringify(agentEnv({
      jobId: job.id, jobDir, proxyPort, brokerToken, oauthToken,
    })), { mode: 0o600 });

    const claudeBin = claudeBinary();
    const claudeDir = dirname(claudeBin);
    const command = [
      '/usr/bin/python3', '-I', helperPath(repoRoot),
      ...agentSandboxFlags({ repoRoot, jobDir, proxyPort, claudeDir, envFile }),
      '--', claudeBin, ...claudeArgs,
    ];
    return {
      command: 'systemd-run',
      args: systemdRunArgv({ unit: `crate-job-${job.id}`, limits: JOB_LIMITS, cwd: repoRoot, command }),
      options: { cwd: repoRoot, env: systemdEnv() },
      cleanup: async () => {
        broker.revoke(brokerToken);
        await rm(jobDir, { recursive: true, force: true });
      },
    };
  };
}

// A restart loses the job's broker, so a surviving unit could only waste quota.
export function stopStaleUnits({ spawn = nodeSpawn } = {}) {
  return new Promise((resolve) => {
    const child = spawn('systemctl', ['--user', 'stop', 'crate-job-*.service', 'crate-worker-*.service'], {
      env: systemdEnv(), stdio: 'ignore',
    });
    child.on('error', () => resolve());
    child.on('close', () => resolve());
  });
}
