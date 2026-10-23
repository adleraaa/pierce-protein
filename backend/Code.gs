// Pierce Protein — rating backend.
// Stores per-dish aggregates in Script Properties (no extra OAuth scopes needed).
//   a:<dish>          -> [sum, count]            all-time
//   d:<date>|<dish>   -> [sum, count]            per day
// GET  ?date=YYYY-MM-DD            -> { all: {dish:[s,c]}, day: {dish:[s,c]} }
// POST {dish, stars, date}          -> same shape, after recording the vote

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
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var props = PropertiesService.getScriptProperties();
    bump_(props, 'a:' + dish, stars);
    bump_(props, 'd:' + date + '|' + dish, stars);
  } finally {
    lock.releaseLock();
  }
  return json_(snapshot_(date));
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
