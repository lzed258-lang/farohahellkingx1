// ─── keep-alive: يمنع الاستضافات المجانية من إيقاف البوت ───
// تقنية GoatBot-Pro: بقاء خادم HTTP حياً عبر ping ذاتي دوري.
// يعمل في الخلفية ولا يتدخل في منطق البوت أبداً.

let keepAliveTimer = null;

function startKeepAlive(config) {
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  if (config.enable === false) return;

  const interval = config.intervalMs || 180000;
  const port = process.env.PORT || 3000;
  const targetUrl = config.url || `http://localhost:${port}/ping`;

  const ping = async () => {
    try {
      const res = await fetch(targetUrl, { method: 'GET', signal: AbortSignal.timeout(10000) });
      console.log(`[KAYDO KEEPALIVE] 🔄 ping → ${res.status}`);
    } catch (e) {
      // فشل الـ ping ليس مميتاً — قد يكون الخادم مشغول
      console.log(`[KAYDO KEEPALIVE] ⚠️ ping failed: ${e.message || e}`);
    }
  };

  // أول ping بعد 30 ثانية ثم بشكل دوري
  setTimeout(ping, 30000);
  keepAliveTimer = setInterval(ping, interval);

  console.log(`[KAYDO KEEPALIVE] 🟢 يعمل كل ${interval / 1000}ث → ${targetUrl}`);
}

function stopKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

module.exports = { startKeepAlive, stopKeepAlive };
