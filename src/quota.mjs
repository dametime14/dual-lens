import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { binary, cleanEnv, runProcess, authStatus } from './providers.mjs';

export function validateCodexQuota(data) {
  const buckets = Object.values(data.rateLimitsByLimitId || { codex: data.rateLimits }).filter(Boolean);
  if (!buckets.length) throw new Error('ChatGPT 구독 사용량을 확인하지 못했습니다.');
  for (const bucket of buckets) {
    if (!bucket.credits || bucket.credits.hasCredits !== false || bucket.credits.unlimited !== false || Number(bucket.credits.balance || 0) !== 0) throw new Error('추가 크레딧 사용 가능 계정입니다. 구독만 사용하는 것을 보장할 수 없어 실행을 멈췄습니다.');
    const windows = [bucket.primary, bucket.secondary].filter(Boolean);
    if (!windows.length || windows.some(w => !Number.isFinite(w.usedPercent))) throw new Error('ChatGPT 사용량 정보가 불완전합니다.');
    if (windows.some(w => w.usedPercent >= 98) || bucket.spendControlReached || bucket.rateLimitReachedType) throw new Error('ChatGPT 구독 한도에 가까워 실행을 멈췄습니다. 한도 초기화 후 다시 시도해 주세요.');
  }
  return { ok: true, source: 'Codex account/rateLimits/read', buckets: buckets.map(b => ({ primary: b.primary, secondary: b.secondary, planType: b.planType })) };
}
export function codexQuota(cwd, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('중지했습니다.'));
    const child = spawn(binary('gpt'), ['app-server', '--listen', 'stdio://', '-c', 'forced_login_method="chatgpt"'], { cwd, env: cleanEnv(), stdio: ['pipe','pipe','pipe'] });
    let buffer = '', done = false;
    const finish = (error, data) => {
      if (done) return; done = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      child.stdin.end(); child.kill();
      error ? reject(error) : resolve(data);
    };
    const abort = () => finish(new Error('중지했습니다.'));
    const timer = setTimeout(() => finish(new Error('ChatGPT 사용량 조회 시간이 초과되었습니다.')), 20000);
    signal?.addEventListener('abort', abort, {once: true});
    const send = value => child.stdin.write(JSON.stringify(value) + '\n');
    child.stdout.setEncoding('utf8');
    child.stderr.resume(); child.stdin.on('error', () => {});
    child.on('error', error => finish(error));
    child.on('exit', () => { if (!done) finish(new Error('ChatGPT 사용량 조회 연결이 종료되었습니다.')); });
    child.stdout.on('data', chunk => {
      buffer += chunk;
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) {
        let message; try { message = JSON.parse(line); } catch { continue; }
        if (message.error) { finish(new Error(message.error.message)); return; }
        if (message.id === 1) {
          send({method: 'initialized'});
          send({id: 2, method: 'account/rateLimits/read'});
        }
        if (message.id === 2) {
          try { finish(null, validateCodexQuota(message.result)); } catch (error) { finish(error); }
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'dual_lens_local', title: 'Dual Lens', version: '1.0.0' } } });
  });
}
export async function checkSubscription(provider, cwd, signal) {
  const auth = await authStatus(provider, cwd, signal);
  if (provider === 'gpt') return { ...auth, quota: await codexQuota(cwd, signal) };
  const check = await runProcess('/usr/bin/python3', [join(import.meta.dirname, 'claude-usage.py'), binary('claude')], {cwd, signal, timeout: 32000});
  let quota; try { quota = JSON.parse(check.stdout); } catch { throw new Error('Claude 추가 과금 설정을 읽을 수 없습니다. 요청을 보내지 않았습니다.'); }
  if (!quota.ok) throw new Error(quota.reason);
  return {...auth, quota};
}
if (process.argv[1] === new URL(import.meta.url).pathname && process.argv[2]) {
  console.log(JSON.stringify(await Promise.all(['gpt', 'claude'].map(p => checkSubscription(p, process.argv[2]))), null, 2));
}
