// Pierce Protein — rating backend.
// Stores per-dish aggregates in Script Properties (no extra OAuth scopes needed).
//   a:<dish>          -> [sum, count]            all-time
//   d:<date>|<dish>   -> [sum, count]            per day
//   x:a:<dish>, x:d:<date>|<dish>                 votes without the owner key: kept, not counted
// GET  ?date=YYYY-MM-DD            -> { all: {dish:[s,c]}, day: {dish:[s,c]} }
// POST {dish, stars, date, key}     -> same shape, after recording the vote

// For now only the owner's votes count. Only the SHA-256 of the key lives here (repo is public).
var OWNER_SHA256 = '39614d3ac9dc9a0980fa5fcd790ae64db5911b91f4f6f77cc0c215e0ee3ca5fb';

function doGet(e) {
  var date = (e && e.parameter && e.parameter.date) || '';
  return json_(snapshot_(date));
}

function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ error: 'bad json' }); }
  var dish = clean_(body.dish);
  var stars = Math.round(Number(body.stars));
  var date = String(body.date || '');
  if (!dish || !(stars >= 1 && stars <= 5) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return json_({ error: 'bad vote' });
  }
  var pre = isOwner_(body.key) ? '' : 'x:';
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var props = PropertiesService.getScriptProperties();
    bump_(props, pre + 'a:' + dish, stars);
    bump_(props, pre + 'd:' + date + '|' + dish, stars);
  } finally {
    lock.releaseLock();
  }
  return json_(snapshot_(date));
}

function isOwner_(key) {
  if (!key) return false;
  var d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(key), Utilities.Charset.UTF_8);
  return d.map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('') === OWNER_SHA256;
}

function bump_(props, key, stars) {
  var cur = JSON.parse(props.getProperty(key) || '[0,0]');
  props.setProperty(key, JSON.stringify([cur[0] + stars, cur[1] + 1]));
}

function snapshot_(date) {
  var all = {}, day = {};
  var p = PropertiesService.getScriptProperties().getProperties();
  var dayPrefix = 'd:' + date + '|';
  Object.keys(p).forEach(function (k) {
    if (k.indexOf('a:') === 0) all[k.slice(2)] = JSON.parse(p[k]);
    else if (date && k.indexOf(dayPrefix) === 0) day[k.slice(dayPrefix.length)] = JSON.parse(p[k]);
  });
  return { all: all, day: day };
}

function clean_(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 120);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
