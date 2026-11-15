// ─── مدير الكوكيز kaydo ───
// تقنيات مستوحاة من GoatBot-Pro:
// 1) فحص حياة الكوكيز فعلياً عبر mbasic.facebook.com قبل أي إعادة دخول.
// 2) حفظ الكوكيز بشكل آمن (كتابة ملف مؤقت ثم استبدال) بعد كل تغيير.
// 3) لا يوجد عمر أقصى إجباري للجلسة — الكوكيز الصالحة تبقى مستخدمة.
// 4) UserAgent ثابت مطابق للجلسة حتى لا يشتبك فيسبوك في تغيّر الجهاز.
const fs = require('fs');
const path = require('path');

let SAVE_INTERVAL_MS = 5 * 60 * 1000;
let CHECK_INTERVAL_MS = 30 * 60 * 1000;
let SAVE_DEBOUNCE_MS = 30 * 1000;
const COOKIE_CHECK_URL = 'https://mbasic.facebook.com/settings';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

const appstatePath = path.join(__dirname, 'appstate.json');
const backupPath = path.join(__dirname, 'appstate.backup.json');

let saveTimer = null;
let checkTimer = null;
let debounceTimer = null;
let pendingSave = false;
let loginTime = null;
let lastSaveAt = null;
let lastCheckAt = null;
let lastCheckOk = null;
let currentApi = null;
let onExpireCallback = null;
let checking = false;

function writeAppStateAtomic(state) {
  const tmpPath = appstatePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
  fs.renameSync(tmpPath, appstatePath);
  // نسخة احتياطية — لو تلف الملف الأساسي نرجع لها
  try {
    fs.copyFileSync(appstatePath, backupPath);
  } catch (e) {}
}

// حفظ فوري — يستخدم عند تسجيل الدخول أو الإغلاق فقط.
function saveAppState(api, reason) {
  if (!api || typeof api.getAppState !== 'function') return false;
  try {
    const state = api.getAppState();
    if (!state || state.length === 0) return false;
    writeAppStateAtomic(state);
    lastSaveAt = Date.now();
    console.log(`[KAYDO COOKIE] 💾 حفظ الكوكيز (${state.length} عنصر) — ${reason || 'دوري'}`);
    return true;
  } catch (e) {
    console.error('[KAYDO COOKIE] خطأ في حفظ الكوكيز:', e.message || e);
    return false;
  }
}

// حفظ مؤجل (debounce) — يجمع عمليات الحفظ المتكررة في عملية واحدة.
// GoatBot-Pro sessionGuard يستخدم debounce بنفس الفكرة لتفادي كتابة
// الملف في كل تغيير صغير، ما يقلل تلف الكوكيز ويطيل عمرها.
function saveAppStateDebounced(api, reason) {
  if (!api || typeof api.getAppState !== 'function') return;
  pendingSave = true;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    if (pendingSave && currentApi) {
      pendingSave = false;
      saveAppState(currentApi, reason || 'حفظ مؤجل');
    }
  }, SAVE_DEBOUNCE_MS);
}

function restoreBackupIfMainMissing() {
  try {
    if (!fs.existsSync(appstatePath) && fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, appstatePath);
      console.log('[KAYDO COOKIE] 🟢 استُعيدت الكوكيز من النسخة الاحتياطية');
      return true;
    }
  } catch (e) {}
  return false;
}

function cookieStringFromApi(api) {
  try {
    const state = api.getAppState();
    if (!Array.isArray(state)) return '';
    return state
      .map((c) => `${c.key || c.name}=${c.value}`)
      .join('; ');
  } catch (e) {
    return '';
  }
}

// فحص حقيقي: هل الكوكيز ما زالت حية؟ (نفس طريقة GoatBot-Pro عبر mbasic)
async function isCookieAlive(api) {
  const cookieString = cookieStringFromApi(api);
  if (!cookieString) return false;
  try {
    const res = await fetch(COOKIE_CHECK_URL, {
      method: 'GET',
      headers: {
        cookie: cookieString,
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
      },
      redirect: 'manual',
    });
    const text = await res.text();
    return (
      text.includes('/privacy/xcs/action/logging/') ||
      text.includes('/notifications.php?') ||
      res.status < 302
    );
  } catch (e) {
    // خطأ شبكة مؤقت ≠ موت الجلسة — نعتبرها حية حتى الفحص القادم
    console.log('[KAYDO COOKIE] ⚠️ تعذر الفحص (شبكة) — نكمل بنفس الجلسة');
    return true;
  }
}

async function runSessionCheck() {
  if (checking || !currentApi) return;
  checking = true;
  try {
    const alive = await isCookieAlive(currentApi);
    lastCheckAt = Date.now();
    lastCheckOk = alive;
    if (!alive) {
      console.log('[KAYDO COOKIE] 🔴 الكوكيز ماتت فعلاً — إعادة تسجيل دخول');
      if (onExpireCallback) onExpireCallback();
    } else {
      saveAppState(currentApi, 'فحص الجلسة');
    }
  } finally {
    checking = false;
  }
}

function startCookieManager(api, options) {
  if (!api) return;
  currentApi = api;
  loginTime = Date.now();
  onExpireCallback =
    options && typeof options.onExpire === 'function' ? options.onExpire : null;

  // اقرأ الإعدادات من connection-config.json إن وُجدت
  try {
    const cfg = require('./connection-config.json');
    if (cfg.cookieManager) {
      if (cfg.cookieManager.saveIntervalMs) SAVE_INTERVAL_MS = cfg.cookieManager.saveIntervalMs;
      if (cfg.cookieManager.checkIntervalMs) CHECK_INTERVAL_MS = cfg.cookieManager.checkIntervalMs;
      if (cfg.cookieManager.saveDebounceMs) SAVE_DEBOUNCE_MS = cfg.cookieManager.saveDebounceMs;
    }
  } catch (e) {}

  restoreBackupIfMainMissing();

  if (saveTimer) clearInterval(saveTimer);
  if (checkTimer) clearInterval(checkTimer);

  // الحفظ الدوري يستخدم النسخة المؤجلة لتفادي الكتابة المتكررة
  saveTimer = setInterval(() => saveAppStateDebounced(currentApi, 'حفظ دوري'), SAVE_INTERVAL_MS);

  checkTimer = setInterval(runSessionCheck, CHECK_INTERVAL_MS);

  console.log(
    `[KAYDO COOKIE] 🔄 مدير الكوكيز يعمل — حفظ كل ${SAVE_INTERVAL_MS / 1000}ث / فحص حياة الجلسة كل ${CHECK_INTERVAL_MS / 60000} دقيقة`,
  );
}

function stopCookieManager() {
  if (saveTimer) {
    clearInterval(saveTimer);
    saveTimer = null;
  }
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
  // حفظ أخير فوري قبل الإيقاف
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (pendingSave && currentApi) {
    pendingSave = false;
    saveAppState(currentApi, 'إيقاف المدير');
  }
  currentApi = null;
  onExpireCallback = null;
  console.log('[KAYDO COOKIE] 🛑 تم إيقاف مدير الكوكيز');
}

function getCookieStatus() {
  let fileExists = false;
  let cookieCount = 0;
  try {
    if (fs.existsSync(appstatePath)) {
      fileExists = true;
      const data = JSON.parse(fs.readFileSync(appstatePath, 'utf8'));
      if (Array.isArray(data)) cookieCount = data.length;
    }
  } catch (e) {}

  const sessionAgeHours = loginTime
    ? (Date.now() - loginTime) / (60 * 60 * 1000)
    : null;

  return {
    loginTime: loginTime ? new Date(loginTime).toISOString() : null,
    sessionAgeHours: sessionAgeHours !== null ? Number(sessionAgeHours.toFixed(2)) : null,
    lastSaveAt: lastSaveAt ? new Date(lastSaveAt).toISOString() : null,
    lastCheckAt: lastCheckAt ? new Date(lastCheckAt).toISOString() : null,
    lastCheckOk,
    fileExists,
    cookieCount,
  };
}

module.exports = { startCookieManager, stopCookieManager, saveAppState, saveAppStateDebounced, getCookieStatus, restoreBackupIfMainMissing, isCookieAlive, USER_AGENT };
