const { parentPort, workerData } = require('node:worker_threads');
const { getQuickJS } = require('quickjs-emscripten');
(async () => {
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(16 * 1024 * 1024);
  runtime.setMaxStackSize(256 * 1024);
  const deadline = Date.now() + workerData.timeout_ms;
  runtime.setInterruptHandler(() => Date.now() > deadline);
  const vm = runtime.newContext();
  let result;
  try {
    const payload = JSON.stringify(workerData.context);
    const code = `(() => { const {input,event,previous} = JSON.parse(${JSON.stringify(payload)}); const result = (function(){"use strict";\n${workerData.code}\n})(); if (result && typeof result.then === "function") throw new Error("Async results are not supported"); return JSON.stringify(result === undefined ? null : result); })()`;
    result = vm.evalCode(code);
    if (result.error) throw new Error('CALLBACK_SCRIPT_FAILED');
    const text = vm.getString(result.value);
    if (Buffer.byteLength(text) > 16384) throw new Error('CALLBACK_OUTPUT_TOO_LARGE');
    parentPort.postMessage({ ok: true, output: JSON.parse(text) });
  } finally {
    result?.error?.dispose();
    result?.value?.dispose();
    vm.dispose();
    runtime.dispose();
  }
})().catch(() => parentPort.postMessage({ ok: false, error: 'CALLBACK_SCRIPT_FAILED' }));
