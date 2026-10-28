// 僅檢查目前程序的健康端點，不登入、不讀寫工作單，也不呼叫 Gemini。
// 使用 Node.js 22 內建 fetch，無需在正式 image 額外安裝 curl。
try {
  const response = await fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/health`, {
    signal: AbortSignal.timeout(3000),
  });
  const body = await response.json();
  if (!response.ok || body?.success !== true || body?.data?.status !== 'ok') process.exitCode = 1;
} catch {
  process.exitCode = 1;
}
