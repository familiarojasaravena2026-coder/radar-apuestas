/* Radar de Apuestas (celular) — motor de análisis.
   Misma lógica que la versión de escritorio, en JavaScript. Todos los datos se guardan
   solo en este teléfono (localStorage). */
'use strict';
const TZ = 'America/Santiago';
const ODDS_BASE = 'https://api.the-odds-api.com/v4';
const APIF_BASE = 'https://v3.football.api-sports.io';
const APIB_BASE = 'https://v1.basketball.api-sports.io';
const DEPORTES = {futbol: 'Fútbol', tenis: 'Tenis', basquetbol: 'Básquetbol'};

const _f = (odds, apif, nombre) => ({deporte: 'futbol', odds, apif, nombre, mercados: 'h2h,totals'});
const COMPETICIONES = {
  chile: _f('soccer_chile_campeonato', 265, 'Primera División de Chile'),
  libertadores: _f('soccer_conmebol_copa_libertadores', 13, 'Copa Libertadores'),
  sudamericana: _f('soccer_conmebol_copa_sudamericana', 11, 'Copa Sudamericana'),
  argentina: _f('soccer_argentina_primera_division', 128, 'Liga Profesional Argentina'),
  brasil: _f('soccer_brazil_campeonato', 71, 'Brasileirão Serie A'),
  mexico: _f('soccer_mexico_ligamx', 262, 'Liga MX'),
  mls: _f('soccer_usa_mls', 253, 'MLS'),
  premier: _f('soccer_epl', 39, 'Premier League'),
  championship: _f('soccer_efl_champ', 40, 'Championship (Inglaterra)'),
  laliga: _f('soccer_spain_la_liga', 140, 'LaLiga'),
  seriea: _f('soccer_italy_serie_a', 135, 'Serie A'),
  bundesliga: _f('soccer_germany_bundesliga', 78, 'Bundesliga'),
  ligue1: _f('soccer_france_ligue_one', 61, 'Ligue 1'),
  portugal: _f('soccer_portugal_primeira_liga', 94, 'Primeira Liga (Portugal)'),
  paisesbajos: _f('soccer_netherlands_eredivisie', 88, 'Eredivisie (Países Bajos)'),
  turquia: _f('soccer_turkey_super_league', 203, 'Süper Lig (Turquía)'),
  champions: _f('soccer_uefa_champs_league', 2, 'Champions League'),
  europa: _f('soccer_uefa_europa_league', 3, 'Europa League'),
  nba: {deporte: 'basquetbol', odds: 'basketball_nba', nombre: 'NBA', mercados: 'h2h,spreads,totals'},
  euroliga: {deporte: 'basquetbol', odds: 'basketball_euroleague', nombre: 'Euroliga', mercados: 'h2h,spreads,totals'},
  tenis_atp: {deporte: 'tenis', prefijo: 'tennis_atp_', nombre: 'Tenis ATP', mercados: 'h2h'},
  tenis_wta: {deporte: 'tenis', prefijo: 'tennis_wta_', nombre: 'Tenis WTA', mercados: 'h2h'},
};
const CASAS_PRECISAS = {pinnacle: 3, betfair_ex_eu: 3, betfair_ex_uk: 3, matchbook: 3};

class ErrorUsuario extends Error {}

/* ---------------------------------------------------------------- almacenamiento */
const Store = {
  get(k, def) { try { const v = localStorage.getItem('rda_' + k); return v == null ? def : JSON.parse(v); } catch (e) { return def; } },
  set(k, v) { try { localStorage.setItem('rda_' + k, JSON.stringify(v)); } catch (e) { Store.limpiarCache(); try { localStorage.setItem('rda_' + k, JSON.stringify(v)); } catch (e2) {} } },
  del(k) { try { localStorage.removeItem('rda_' + k); } catch (e) {} },
  limpiarCache() {  // borra cachés de días anteriores para liberar espacio
    try {
      const hoy = ymd(new Date());
      Object.keys(localStorage).filter(k => k.startsWith('rda_c_') && !k.includes(hoy)).forEach(k => localStorage.removeItem(k));
    } catch (e) {}
  },
};

const DEFAULTS = {odds_api: '', api_football: '', prob_min: 0.45, ev_min: 0.03, banca: 100000, kelly: 0.25,
  peso_mercado: 0.7, cuota_min_pick: 1.15, min_casas: 3, region: 'eu', ligas: Object.keys(COMPETICIONES)};
function leerConfig() {
  const c = Object.assign({}, DEFAULTS, Store.get('config', {}));
  c.ligas = (c.ligas || []).filter(x => COMPETICIONES[x]);
  return c;
}
function guardarConfig(cambios) {
  const c = leerConfig();
  for (const k of ['odds_api', 'api_football']) if (cambios[k] != null) c[k] = String(cambios[k]).trim();
  for (const k of ['prob_min', 'ev_min', 'banca', 'kelly', 'cuota_min_pick']) if (k in cambios) c[k] = Number(cambios[k]);
  if ('ligas' in cambios) {
    const l = cambios.ligas.filter(x => COMPETICIONES[x]);
    if (!l.length) throw new ErrorUsuario('Elige al menos una liga o deporte.');
    c.ligas = l;
  }
  Store.set('config', c);
  return c;
}

/* ---------------------------------------------------------------- fechas (hora de Chile) */
const ymd = d => new Date(d).toLocaleDateString('en-CA', {timeZone: TZ});
function offsetChile(d) {
  const p = new Intl.DateTimeFormat('en-US', {timeZone: TZ, timeZoneName: 'longOffset'}).formatToParts(d)
    .find(x => x.type === 'timeZoneName').value;  // "GMT-03:00"
  const m = p.match(/GMT([+-]\d{2}):?(\d{2})?/);
  return m ? `${m[1]}:${m[2] || '00'}` : '-03:00';
}
function inicioDia(d) { const s = ymd(d); return new Date(`${s}T00:00:00${offsetChile(new Date(`${s}T12:00:00Z`))}`); }
const RANGOS = {hoy: [0, 0, 'hoy'], manana: [1, 1, 'mañana'], '3': [0, 2, 'los próximos 3 días'], '7': [0, 6, 'los próximos 7 días']};
function ventana(rango) {
  const [d0, d1] = RANGOS[rango];
  const ahora = new Date(), hoy0 = inicioDia(ahora);
  const dia = k => inicioDia(new Date(hoy0.getTime() + k * 864e5 + 432e5));
  const desde = new Date(Math.max(ahora.getTime(), dia(d0).getTime()));
  const hasta = new Date(dia(d1 + 1).getTime() - 1000);
  const fechas = []; for (let k = d0; k <= d1; k++) fechas.push(ymd(dia(k)));
  return [desde, hasta, fechas];
}
const fmtUtc = d => d.toISOString().slice(0, 19) + 'Z';

/* ---------------------------------------------------------------- texto */
const STOP = new Set('fc cf club cd sc ac de del deportivo the afc ssc as ca se cr sad calcio futbol football y sa ec rc cp bc bk kk basket baloncesto'.split(' '));
function norm(s) {
  return (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/).filter(w => w && !STOP.has(w)).join(' ');
}
function _coincide(a, b) {  // Ratcliff/Obershelp, como SequenceMatcher de Python
  if (!a.length || !b.length) return 0;
  let best = 0, ia = 0, ib = 0;
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
    let k = 0; while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) k++;
    if (k > best) { best = k; ia = i; ib = j; }
  }
  if (!best) return 0;
  return best + _coincide(a.slice(0, ia), b.slice(0, ib)) + _coincide(a.slice(ia + best), b.slice(ib + best));
}
function sim(a, b) {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  return 2 * _coincide(na, nb) / (na.length + nb.length);
}
const fmtG = x => String(Number(x));  // como {:g} de Python
const fmtSigno = x => (x > 0 ? '+' : '') + fmtG(x);

/* ---------------------------------------------------------------- conexiones */
async function _fetch(url, opts, nombre) {
  try { return await fetch(url, opts); }
  catch (e) { const err = new ErrorUsuario(`No pude conectarme a ${nombre}. Revisa tu conexión a internet.`); err.red = true; throw err; }
}
class OddsAPI {
  constructor(key, region) { this.key = key; this.region = region; this.restantes = null; this.gastados = 0; }
  async _get(path, params) {
    const u = new URL(ODDS_BASE + path); u.searchParams.set('apiKey', this.key);
    for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, v);
    const r = await _fetch(u, {}, 'The Odds API');
    const rest = r.headers.get('x-requests-remaining'); if (rest != null) this.restantes = rest;
    if (r.status === 401) throw new ErrorUsuario('The Odds API rechazó la clave de cuotas. Revísala en Ajustes.');
    if (r.status === 429) throw new ErrorUsuario('Se acabaron los créditos del mes en The Odds API (se renuevan el día 1). Apaga ligas en Ajustes mientras tanto.');
    if (r.status === 422) return [];
    if (!r.ok) throw new ErrorUsuario(`The Odds API respondió con error ${r.status}.`);
    return r.json();
  }
  async deportesActivos() {
    const k = 'c_sports_' + ymd(new Date()) + '_' + new Date().getHours();
    let d = Store.get(k); if (!d) { d = (await this._get('/sports')).map(x => x.key); Store.set(k, d); }
    return new Set(d);
  }
  async eventos(sport, desde, hasta) {
    const k = `c_ev_${sport}_${desde.slice(0, 13)}_${hasta.slice(0, 13)}_${ymd(new Date())}`;
    const c = Store.get(k); if (c && Date.now() - c.t < 6e5) return c.d;
    const d = await this._get(`/sports/${sport}/events`, {commenceTimeFrom: desde, commenceTimeTo: hasta});
    Store.set(k, {t: Date.now(), d}); return d;
  }
  async cuotas(sport, mercados, desde, hasta) {
    const d = await this._get(`/sports/${sport}/odds`, {regions: this.region, markets: mercados, oddsFormat: 'decimal',
      dateFormat: 'iso', commenceTimeFrom: desde, commenceTimeTo: hasta});
    if (d && d.length) this.gastados += mercados.split(',').length;
    return d;
  }
}
class ApiSports {
  constructor(key, base = APIF_BASE, nombre = 'API-Football') { this.key = key; this.base = base; this.nombre = nombre; this.restantes = null; }
  async _get(path, params) {
    if (!this.key) return null;
    const u = new URL(this.base + path);
    for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, v);
    let r;
    try { r = await fetch(u, {headers: {'x-apisports-key': this.key}}); }
    catch (e) {
      Store.set('apif_bloqueado', true);
      const err = new ErrorUsuario(`${this.nombre} no permite la conexión directa desde el celular o no hay internet.`); err.bloqueo = true; throw err;
    }
    Store.set('apif_bloqueado', false);
    const rest = r.headers.get('x-ratelimit-requests-remaining'); if (rest != null) this.restantes = rest;
    if (!r.ok) throw new ErrorUsuario(`${this.nombre} respondió con error ${r.status}.`);
    const data = await r.json();
    const errs = data.errors;
    if (errs && (Array.isArray(errs) ? errs.length : Object.keys(errs).length)) {
      const msg = typeof errs === 'string' ? errs : Object.entries(errs).map(([k, v]) => `${k}: ${v}`).join('; ');
      throw new ErrorUsuario(`${this.nombre}: ${msg}`);
    }
    return data.response || [];
  }
  async _cache(nombre, fn) {
    const k = `c_${ymd(new Date())}_${nombre}`;
    const c = Store.get(k); if (c) return c;
    const d = await fn(); if (d != null) Store.set(k, d); return d;
  }
  partidosDelDia(fecha) { return this._cache('fx_' + fecha, () => this._get('/fixtures', {date: fecha, timezone: TZ})).then(d => d || []); }
  tabla(liga, temp) { return this._cache(`tb_${liga}_${temp}`, () => this._get('/standings', {league: liga, season: temp})).then(d => d || []); }
}

function factorForma(forma, puntos, jugados) {  // entre 0,90 y 1,10
  forma = (forma || '').slice(-5);
  if (forma.length < 3 || !jugados) return 1;
  const ppg5 = [...forma].reduce((s, c) => s + (c === 'W' ? 3 : c === 'D' ? 1 : 0), 0) / forma.length;
  return Math.max(0.9, Math.min(1.1, 1 + 0.1 * (ppg5 - (puntos || 0) / jugados)));
}
function statsDesdeTabla(resp) {
  const eq = {};
  if (!resp || !resp.length) return [eq, null];
  for (const grupo of resp[0].league.standings) for (const e of grupo) {
    const h = e.home || {}, a = e.away || {};
    eq[e.team.id] = {nombre: e.team.name, hP: h.played || 0, hGF: (h.goals || {}).for || 0, hGA: (h.goals || {}).against || 0,
      aP: a.played || 0, aGF: (a.goals || {}).for || 0, aGA: (a.goals || {}).against || 0,
      forma: factorForma(e.form, e.points, (e.all || {}).played)};
  }
  const v = Object.values(eq), hp = v.reduce((s, t) => s + t.hP, 0), ap = v.reduce((s, t) => s + t.aP, 0);
  if (hp < 10 || ap < 10) return [eq, null];
  const prom = {hg: v.reduce((s, t) => s + t.hGF, 0) / hp, ag: v.reduce((s, t) => s + t.aGF, 0) / ap};
  return prom.hg > 0 && prom.ag > 0 ? [eq, prom] : [eq, null];
}

/* ---------------------------------------------------------------- modelo de goles */
const FACT = [1]; for (let i = 1; i < 20; i++) FACT[i] = FACT[i - 1] * i;
const pois = (k, l) => Math.exp(-l) * Math.pow(l, k) / FACT[k];
function matriz(lh, la, rho = -0.08, maxg = 9) {
  const m = [];
  for (let i = 0; i <= maxg; i++) { m.push([]); for (let j = 0; j <= maxg; j++) m[i].push(pois(i, lh) * pois(j, la)); }
  m[0][0] *= Math.max(0, 1 - lh * la * rho); m[0][1] *= Math.max(0, 1 + lh * rho);
  m[1][0] *= Math.max(0, 1 + la * rho); m[1][1] *= Math.max(0, 1 - rho);
  let s = 0; m.forEach(f => f.forEach(x => s += x));
  return m.map(f => f.map(x => x / s));
}
function probsDeMatriz(m, lineas) {
  const n = m.length; let p1 = 0, px = 0, btts = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (i > j) p1 += m[i][j]; else if (i === j) px += m[i][j];
    if (i > 0 && j > 0) btts += m[i][j];
  }
  const p2 = 1 - p1 - px;
  const out = {'1': p1, X: px, '2': p2, '1X': p1 + px, X2: px + p2, '12': p1 + p2, btts_si: btts, btts_no: 1 - btts};
  for (const L of lineas) {
    let over = 0; for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i + j > L) over += m[i][j];
    out['over_' + fmtG(L)] = over; out['under_' + fmtG(L)] = 1 - over;
  }
  return out;
}
function ajustarLambdas(obj) {
  const lineas = Object.keys(obj).filter(k => k.startsWith('over_')).map(k => Number(k.split('_')[1]));
  const perd = (lh, la) => { const p = probsDeMatriz(matriz(lh, la, -0.08, 8), lineas); let e = 0; for (const k in obj) e += (p[k] - obj[k]) ** 2; return e; };
  let best = [1.4, 1.1, 9e9];
  for (let i = 0; i < 40; i++) for (let j = 0; j < 40; j++) { const lh = 0.15 + 0.1 * i, la = 0.15 + 0.1 * j, e = perd(lh, la); if (e < best[2]) best = [lh, la, e]; }
  const [l0, a0] = best;
  for (let i = -10; i <= 10; i++) for (let j = -10; j <= 10; j++) {
    const lh = l0 + 0.01 * i, la = a0 + 0.01 * j;
    if (lh > 0.05 && la > 0.05) { const e = perd(lh, la); if (e < best[2]) best = [lh, la, e]; }
  }
  return [best[0], best[1]];
}
function lambdasEst(l, v, prom, k = 4) {
  const {hg, ag} = prom;
  const attL = ((l.hGF + k * hg) / (l.hP + k)) / hg, defL = ((l.hGA + k * ag) / (l.hP + k)) / ag;
  const attV = ((v.aGF + k * ag) / (v.aP + k)) / ag, defV = ((v.aGA + k * hg) / (v.aP + k)) / hg;
  const fl = l.forma || 1, fv = v.forma || 1;
  return [attL * defV * hg * Math.sqrt(fl / fv), attV * defL * ag * Math.sqrt(fv / fl)];
}

/* ---------------------------------------------------------------- consenso del mercado */
function consenso(ev, deporte = 'futbol') {
  const home = ev.home_team, away = ev.away_team, nH2h = deporte === 'futbol' ? 3 : 2;
  const grupos = {};
  for (const bk of ev.bookmakers || []) {
    const w = CASAS_PRECISAS[bk.key] || 1, titulo = bk.title || bk.key;
    for (const m of bk.markets || []) {
      if (!['h2h', 'totals', 'spreads'].includes(m.key)) continue;
      const porG = {};
      for (const o of m.outcomes || []) {
        const precio = o.price || 0; if (precio <= 1) continue;
        let g, k;
        if (m.key === 'h2h') { g = 'h2h'; k = {Draw: 'X', [home]: '1', [away]: '2'}[o.name]; }
        else if (m.key === 'totals') { if (o.point == null) continue; g = 'totals|' + Number(o.point); k = o.name === 'Over' ? 'over' : 'under'; }
        else {
          if (o.point == null || (o.name !== home && o.name !== away)) continue;
          const pt = Number(o.point), hp = o.name === home ? pt : -pt;
          g = 'spreads|' + hp; k = o.name === home ? 'hcp1' : 'hcp2';
        }
        if (k) (porG[g] = porG[g] || {})[k] = precio;
      }
      for (const [g, outs] of Object.entries(porG)) {
        if (Object.keys(outs).length < (g === 'h2h' ? nH2h : 2)) continue;
        const inv = {}; let s = 0; for (const [k, v] of Object.entries(outs)) { inv[k] = 1 / v; s += inv[k]; }
        const G = grupos[g] = grupos[g] || {};
        for (const [k, v] of Object.entries(outs)) {
          const r = G[k] = G[k] || {probs: [], best: 0, book: '', books: new Set()};
          r.probs.push([inv[k] / s, w, bk.key]); r.books.add(titulo);
          if (v > r.best) { r.best = v; r.book = titulo; }
        }
      }
    }
  }
  const out = {};
  for (const [g, G] of Object.entries(grupos)) for (const [k, r] of Object.entries(G)) {
    // Pinnacle es la referencia principal: 70% Pinnacle, 30% el resto de las casas
    const pin = r.probs.filter(x => x[2] === 'pinnacle').map(x => x[0]), otros = r.probs.filter(x => x[2] !== 'pinnacle');
    const prom = otros.length ? otros.reduce((s, x) => s + x[0] * x[1], 0) / otros.reduce((s, x) => s + x[1], 0) : null;
    const p = pin.length && otros.length ? 0.7 * pin[0] + 0.3 * prom : pin.length ? pin[0] : prom;
    let oid;
    if (g === 'h2h') oid = k;
    else { const [tipo, val] = g.split('|'); const v = Number(val);
      oid = tipo === 'totals' ? `${k}_${fmtG(v)}` : (k === 'hcp1' ? `hcp1_${fmtSigno(v)}` : `hcp2_${fmtSigno(-v)}`); }
    out[oid] = {p, best: r.best, book: r.book, n: r.books.size, pin: pin.length > 0};
  }
  return out;
}

/* ---------------------------------------------------------------- opciones y análisis */
function familia(oid) {
  if (['1', 'X', '2'].includes(oid)) return 'ganador';
  if (['1X', 'X2', '12'].includes(oid)) return 'doble';
  if (oid.startsWith('btts')) return 'btts';
  if (oid.startsWith('hcp')) return 'hcp';
  return oid.split('_')[0];
}
function etiqueta(oid, local, visita, dep = 'futbol') {
  if (dep === 'futbol') {
    if (oid === '1') return ['Ganador (1X2)', `Gana ${local}`];
    if (oid === 'X') return ['Ganador (1X2)', 'Empate'];
    if (oid === '2') return ['Ganador (1X2)', `Gana ${visita}`];
  } else {
    if (oid === '1') return ['Ganador del partido', `Gana ${local}`];
    if (oid === '2') return ['Ganador del partido', `Gana ${visita}`];
  }
  if (oid === '1X') return ['Doble oportunidad', `${local} o empate`];
  if (oid === 'X2') return ['Doble oportunidad', `${visita} o empate`];
  if (oid === '12') return ['Doble oportunidad', 'Cualquiera gana (no empate)'];
  if (oid === 'btts_si') return ['Ambos marcan', 'Sí'];
  if (oid === 'btts_no') return ['Ambos marcan', 'No'];
  const [tipo, linea] = oid.split('_');
  if (tipo === 'hcp1' || tipo === 'hcp2') return ['Hándicap', `${tipo === 'hcp1' ? local : visita} ${linea}`];
  const total = dep === 'futbol' ? 'Total de goles' : dep === 'basquetbol' ? 'Total de puntos' : 'Total';
  return [total, (tipo === 'over' ? 'Más de ' : 'Menos de ') + linea];
}
function _opcion(oid, p, m, local, visita, dep, cfg) {
  const [mercado, sel] = etiqueta(oid, local, visita, dep);
  const mejor = m && m.n >= cfg.min_casas ? m.best : null;
  return {id: oid, familia: familia(oid), mercado, sel, p: Math.round(p * 1e4) / 1e4, mejor, casa: mejor ? m.book : null, n: m ? m.n : 0};
}
const ORDEN_MKT = {'Ganador (1X2)': 0, 'Ganador del partido': 0, 'Doble oportunidad': 1, 'Hándicap': 2, 'Total de goles': 3, 'Total de puntos': 3, 'Total': 3, 'Ambos marcan': 4};
const ordenar = ops => ops.sort((a, b) => (ORDEN_MKT[a.mercado] - ORDEN_MKT[b.mercado]) || (a.id < b.id ? -1 : 1));

function analizarFutbol(local, visita, mercado, lamEst, cfg) {
  const w = cfg.peso_mercado;
  const lineas = [...new Set([1.5, 2.5, 3.5, ...Object.keys(mercado).filter(k => k.startsWith('over_')).map(k => Number(k.split('_')[1]))])].sort((a, b) => a - b);
  let pM = null, lamM = null;
  if (mercado['1'] && mercado.X && mercado['2']) {
    const obj = {'1': mercado['1'].p, X: mercado.X.p, '2': mercado['2'].p};
    const tot = Object.keys(mercado).filter(k => k.startsWith('over_')).map(k => [mercado[k].n, k]);
    if (tot.length) { tot.sort((a, b) => (a[0] - b[0]) || ((a[1] === 'over_2.5') - (b[1] === 'over_2.5'))); const k = tot[tot.length - 1][1]; obj[k] = mercado[k].p; }
    lamM = ajustarLambdas(obj);
    pM = probsDeMatriz(matriz(...lamM), lineas);
    for (const [k, v] of Object.entries(mercado)) pM[k] = v.p;
    pM['1X'] = pM['1'] + pM.X; pM.X2 = pM.X + pM['2']; pM['12'] = pM['1'] + pM['2'];
  }
  const pE = lamEst ? probsDeMatriz(matriz(...lamEst), lineas) : null;
  let fuente, fin, acuerdo = null;
  if (pM && pE) { fuente = 'Mercado + estadísticas'; fin = {}; for (const k in pM) if (k in pE) fin[k] = w * pM[k] + (1 - w) * pE[k];
    acuerdo = ['1', 'X', '2'].reduce((s, k) => s + Math.abs(pM[k] - pE[k]), 0) / 3; }
  else if (pM) { fuente = 'Solo mercado'; fin = pM; }
  else if (pE) { fuente = 'Solo estadísticas'; fin = pE; }
  else return null;
  const opciones = Object.entries(fin).filter(([, p]) => p > 0.01 && p < 0.995).map(([oid, p]) => _opcion(oid, p, mercado[oid], local, visita, 'futbol', cfg));
  const lam = lamM && lamEst ? [w * lamM[0] + (1 - w) * lamEst[0], w * lamM[1] + (1 - w) * lamEst[1]] : (lamM || lamEst);
  return {fuente, lambdas: lam.map(x => Math.round(x * 100) / 100), opciones: ordenar(opciones),
    _acuerdo: acuerdo, _pin: Object.values(mercado).some(v => v.pin)};
}
function analizarMercado(ev, dep, cfg) {
  const m = consenso(ev, dep), val = {};
  for (const [k, v] of Object.entries(m)) if (v.n >= cfg.min_casas) val[k] = v;
  if (!val['1'] || !val['2']) return null;
  const opciones = Object.entries(val).filter(([, v]) => v.p > 0.01 && v.p < 0.995).map(([oid, v]) => _opcion(oid, v.p, v, ev.home_team, ev.away_team, dep, cfg));
  return {fuente: 'Solo mercado', lambdas: null, opciones: ordenar(opciones), _acuerdo: null, _pin: Object.values(val).some(v => v.pin)};
}
function confianza(fuente, casas, pin, acuerdo, jugados) {
  const base = {'Mercado + estadísticas': 0.9, 'Solo mercado': 0.8, 'Solo estadísticas': 0.45}[fuente];
  const motivos = [{'Mercado + estadísticas': 'mercado y estadísticas', 'Solo mercado': 'solo mercado', 'Solo estadísticas': 'solo estadísticas, sin cuotas'}[fuente]];
  let c = base * (0.7 + 0.3 * Math.min(casas / 8, 1));
  motivos.push(casas ? `${casas} casas` : 'sin casas');
  if (pin) { c = Math.min(1, c + 0.08); motivos.push('con Pinnacle'); }
  if (acuerdo != null) {
    c *= 1 - 0.4 * Math.min(acuerdo / 0.15, 1);
    motivos.push(acuerdo < 0.05 ? 'modelo y mercado coinciden' : acuerdo > 0.10 ? 'modelo y mercado difieren' : 'modelo y mercado se parecen');
  }
  if (jugados != null) { c *= 0.8 + 0.2 * Math.min(jugados / 16, 1); if (jugados < 10) motivos.push('pocos partidos jugados'); }
  const v = Math.round(c * 100);
  return {valor: v, nivel: v >= 75 ? 'Alta' : v >= 55 ? 'Media' : 'Baja', motivos};
}
function seleccion(partido, cfg) {
  const cands = [];
  for (const o of partido.opciones) {
    if (1 / o.p < cfg.cuota_min_pick) continue;
    const q = o.mejor, c = Object.assign({}, o);
    c.ev = q ? o.p * q - 1 : null;
    c.valor = c.ev != null && c.ev >= cfg.ev_min && o.p >= cfg.prob_min;
    let f = q ? (o.p * q - 1) / (q - 1) : 0; f = f > 0 ? Math.min(0.05, f * cfg.kelly) : 0;
    c.g = f > 0 ? o.p * Math.log(1 + f * (q - 1)) + (1 - o.p) * Math.log(1 - f) : 0;
    cands.push(c);
  }
  if (!cands.length) return [null, []];
  const cv = cands.filter(c => c.valor);
  const primera = cv.length ? cv.reduce((a, b) => b.g > a.g ? b : a) : cands.reduce((a, b) => b.p > a.p ? b : a);
  const mejores = {};
  for (const c of cands) if (c.valor && c.p >= 0.75) mejores[c.id] = c;
  if (primera.valor) mejores[primera.id] = primera;
  return [primera, Object.values(mejores)];
}

/* ---------------------------------------------------------------- recolección */
function clavesOdds(comp, activos) {
  const c = COMPETICIONES[comp];
  if (c.prefijo) return [...activos].filter(k => k.startsWith(c.prefijo)).sort();
  return activos.has(c.odds) ? [c.odds] : [];
}
async function estimar(cfg, rango) {
  if (!cfg.odds_api) return {creditos: 0, competiciones: [], restantes: null};
  const [ini, fin] = ventana(rango), desde = fmtUtc(ini), hasta = fmtUtc(fin);
  const odds = new OddsAPI(cfg.odds_api, cfg.region), activos = await odds.deportesActivos();
  let total = 0; const det = [];
  for (const comp of cfg.ligas) for (const sport of clavesOdds(comp, activos)) {
    const n = (await odds.eventos(sport, desde, hasta)).length;
    if (n) { const costo = COMPETICIONES[comp].mercados.split(',').length; total += costo; det.push({comp: COMPETICIONES[comp].nombre, partidos: n, creditos: costo}); }
  }
  return {creditos: total, competiciones: det, restantes: odds.restantes};
}
async function recolectar(cfg, rango, log) {
  if (!cfg.odds_api && !cfg.api_football) throw new ErrorUsuario('Falta pegar las claves. Ábrelas en Ajustes.');
  const [ini, fin, fechas] = ventana(rango), desde = fmtUtc(ini), hasta = fmtUtc(fin), avisos = [];
  const odds = cfg.odds_api ? new OddsAPI(cfg.odds_api, cfg.region) : null;
  const apif = new ApiSports(cfg.api_football);
  const eventos = [];
  if (odds) {
    const activos = await odds.deportesActivos();
    for (const comp of cfg.ligas) {
      const c = COMPETICIONES[comp];
      for (const sport of clavesOdds(comp, activos)) {
        log(`Revisando ${c.nombre}…`);
        if (!(await odds.eventos(sport, desde, hasta)).length) continue;
        for (const ev of await odds.cuotas(sport, c.mercados, desde, hasta)) eventos.push([comp, ev]);
      }
    }
  } else avisos.push('Sin clave de The Odds API: el fútbol se analiza solo con estadísticas y no hay tenis ni básquetbol.');
  const fixtures = [], tablas = {};
  const ligasF = {}; for (const c of cfg.ligas) if (COMPETICIONES[c].deporte === 'futbol') ligasF[COMPETICIONES[c].apif] = c;
  if (cfg.api_football && Object.keys(ligasF).length) {
    log('Descargando estadísticas de los equipos…');
    try {
      for (const f of fechas) for (const fx of await apif.partidosDelDia(f)) {
        if (ligasF[fx.league.id] && ['NS', 'TBD'].includes(fx.fixture.status.short)) {
          const t = new Date(fx.fixture.date); if (t >= ini && t <= fin) fixtures.push(fx);
        }
      }
      for (const fx of fixtures) {
        const k = fx.league.id + '|' + fx.league.season;
        if (!(k in tablas)) { try { tablas[k] = statsDesdeTabla(await apif.tabla(fx.league.id, fx.league.season)); } catch (e) { avisos.push(e.message); tablas[k] = [{}, null]; } }
      }
    } catch (e) {
      if (!(e instanceof ErrorUsuario)) throw e;
      avisos.push(e.bloqueo ? 'API-Football no permite la conexión directa desde el celular: el fútbol se analiza solo con el mercado y los resultados se marcan a mano.' : e.message);
      fixtures.length = 0;
    }
  } else if (!cfg.api_football) avisos.push('Sin clave de API-Football: el fútbol se analiza solo con el mercado y los resultados no se revisan solos.');
  return {eventos, fixtures, tablas, avisos, odds, apif};
}
function emparejar(ev, comp, fixtures) {
  const t = new Date(ev.commence_time).getTime(); let mejor = null, punt = 0.55;
  for (const fx of fixtures) {
    if (fx.league.id !== COMPETICIONES[comp].apif) continue;
    if (Math.abs(new Date(fx.fixture.date).getTime() - t) > 3 * 3600e3) continue;
    const s = (sim(ev.home_team, fx.teams.home.name) + sim(ev.away_team, fx.teams.away.name)) / 2;
    if (s > punt) { mejor = fx; punt = s; }
  }
  return mejor;
}
function jugadosDeFixture(fx, tablas) {
  if (!fx) return null;
  const [eq] = tablas[fx.league.id + '|' + fx.league.season] || [{}, null];
  const l = eq[fx.teams.home.id], v = eq[fx.teams.away.id];
  return l && v ? Math.min(l.hP + l.aP, v.hP + v.aP) : null;
}
function lamDeFixture(fx, tablas) {
  if (!fx) return null;
  const [eq, prom] = tablas[fx.league.id + '|' + fx.league.season] || [{}, null];
  const l = eq[fx.teams.home.id], v = eq[fx.teams.away.id];
  if (!(prom && l && v) || l.hP + l.aP < 3 || v.hP + v.aP < 3) return null;
  return lambdasEst(l, v, prom);
}
function construirPartidos(eventos, fixtures, tablas, cfg) {
  const partidos = [], descartados = [], usados = new Set();
  const base = (comp, local, visita, hora) => ({competicion: comp, deporte: COMPETICIONES[comp].deporte, liga: COMPETICIONES[comp].nombre, local, visita, hora});
  for (const [comp, ev] of eventos) {
    const dep = COMPETICIONES[comp].deporte, b = base(comp, ev.home_team, ev.away_team, ev.commence_time);
    let res, motivo, fid = null, fx = null;
    if (dep === 'futbol') {
      fx = emparejar(ev, comp, fixtures); if (fx) { usados.add(fx.fixture.id); fid = fx.fixture.id; }
      res = analizarFutbol(ev.home_team, ev.away_team, consenso(ev, dep), lamDeFixture(fx, tablas), cfg);
      motivo = 'Las casas aún no publican cuotas completas y no hay estadísticas suficientes de los equipos.';
    } else { res = analizarMercado(ev, dep, cfg); motivo = `Menos de ${cfg.min_casas} casas con cuotas para este partido.`; }
    if (res) {
      Object.assign(res, b, {key: 'o-' + ev.id, fixture_id: fid, casas: (ev.bookmakers || []).length});
      const jug = dep === 'futbol' && res.fuente !== 'Solo mercado' ? jugadosDeFixture(fx, tablas) : null;
      res.confianza = confianza(res.fuente, res.casas, res._pin, res._acuerdo, jug); delete res._pin; delete res._acuerdo;
      if (dep === 'tenis' && ev.sport_title) res.liga = ev.sport_title;
      partidos.push(res);
    } else descartados.push(Object.assign(b, {motivo}));
  }
  const id2comp = {}; for (const [k, c] of Object.entries(COMPETICIONES)) if (c.deporte === 'futbol') id2comp[c.apif] = k;
  for (const fx of fixtures) {
    if (usados.has(fx.fixture.id)) continue;
    const b = base(id2comp[fx.league.id], fx.teams.home.name, fx.teams.away.name, fx.fixture.date);
    const res = analizarFutbol(b.local, b.visita, {}, lamDeFixture(fx, tablas), cfg);
    if (res) {
      Object.assign(res, b, {key: 'f-' + fx.fixture.id, fixture_id: fx.fixture.id, casas: 0});
      res.confianza = confianza(res.fuente, 0, res._pin, res._acuerdo, jugadosDeFixture(fx, tablas)); delete res._pin; delete res._acuerdo;
      partidos.push(res);
    }
    else descartados.push(Object.assign(b, {motivo: 'Sin cuotas en el agregador y menos de 3 partidos jugados en la tabla (copa, fase final o inicio de torneo).'}));
  }
  return [partidos, descartados];
}
function marcarMovimientos(partidos, demo) {
  if (demo) {  // en el ejemplo se simula un movimiento para mostrarlo
    for (const p of partidos.slice(0, 3)) for (const o of p.opciones) if ((o.id === '1' || o.id === 'over_2.5') && o.mejor) { o.p0 = Math.round((o.p - 0.04) * 1e4) / 1e4; o.q0 = Math.round(o.mejor * 108) / 100; }
    return;
  }
  const hist = Store.get('movimientos', {}), lim = Date.now() - 864e5;
  for (const k of Object.keys(hist)) if (new Date(hist[k].hora).getTime() < lim) delete hist[k];
  for (const p of partidos) {
    const h = hist[p.key] = hist[p.key] || {hora: p.hora, op: {}};
    for (const o of p.opciones) { const ini = h.op[o.id]; if (!ini) h.op[o.id] = {p: o.p, q: o.mejor}; else { o.p0 = ini.p; o.q0 = ini.q; } }
  }
  Store.set('movimientos', hist);
}
async function correr(rango, demo, log) {
  const cfg = leerConfig();
  let eventos, fixtures, tablas, avisos, creditos = {}, gastados = 0;
  if (demo) { ({eventos, fixtures, tablas} = datosDemo(rango)); avisos = ['Datos inventados: no son partidos ni cuotas reales.']; }
  else {
    log(`Buscando partidos de ${RANGOS[rango][2]}…`);
    const r = await recolectar(cfg, rango, log);
    ({eventos, fixtures, tablas, avisos} = r);
    creditos = {odds: r.odds ? r.odds.restantes : null}; gastados = r.odds ? r.odds.gastados : 0;
    if (r.odds && r.odds.restantes != null && Number(r.odds.restantes) < 100)
      avisos.unshift(`Te quedan ${Math.floor(Number(r.odds.restantes))} créditos de cuotas este mes. Apaga ligas en Ajustes o usa rangos más cortos.`);
  }
  log('Calculando probabilidades…');
  await new Promise(r => setTimeout(r, 30));
  const [partidos, descartados] = construirPartidos(eventos, fixtures, tablas, cfg);
  marcarMovimientos(partidos, demo);
  const ahora = new Date();
  return {version: 2, rango, generado: ahora.toLocaleString('es-CL', {timeZone: TZ, dateStyle: 'short', timeStyle: 'short'}),
    generado_ts: ahora.getTime() / 1000, demo, creditos, gastados, avisos, partidos, descartados};
}

/* ---------------------------------------------------------------- resultados */
function gana(op, h, a) {
  if (op === '1') return h > a; if (op === 'X') return h === a; if (op === '2') return h < a;
  if (op === '1X') return h >= a; if (op === 'X2') return h <= a; if (op === '12') return h !== a;
  if (op === 'btts_si') return h > 0 && a > 0; if (op === 'btts_no') return !(h > 0 && a > 0);
  const [tipo, ls] = op.split('_'), L = Number(ls);
  if (tipo === 'over' || tipo === 'under') { if (h + a === L) return null; return tipo === 'over' ? h + a > L : h + a < L; }
  const d = tipo === 'hcp1' ? h + L - a : a + L - h;
  return d === 0 ? null : d > 0;
}
const listo = (i, horas) => new Date(i.hora).getTime() + horas * 3600e3 < Date.now();
async function resolver(items) {
  const cfg = leerConfig(); if (!cfg.api_football) return {};
  const out = {};
  const fut = items.filter(i => (i.deporte || 'futbol') === 'futbol' && i.fixture_id && listo(i, 2));
  if (fut.length) {
    const api = new ApiSports(cfg.api_football), ids = [...new Set(fut.map(i => i.fixture_id))].sort(), part = {};
    for (let k = 0; k < ids.length; k += 20) for (const fx of (await api._get('/fixtures', {ids: ids.slice(k, k + 20).join('-')})) || []) part[fx.fixture.id] = fx;
    for (const i of fut) {
      const fx = part[i.fixture_id]; if (!fx) continue;
      const st = fx.fixture.status.short;
      if (['FT', 'AET', 'PEN'].includes(st)) {
        const ft = (fx.score || {}).fulltime || {};
        const h = ft.home != null ? ft.home : fx.goals.home, a = ft.away != null ? ft.away : fx.goals.away, g = gana(i.opcion, h, a);
        out[i.id] = [g == null ? 'nula' : g ? 'ganada' : 'perdida', `${h}-${a}`];
      } else if (['PST', 'CANC', 'ABD', 'AWD', 'WO'].includes(st)) out[i.id] = ['nula', st];
    }
  }
  const bas = items.filter(i => i.deporte === 'basquetbol' && listo(i, 3));
  if (bas.length) {
    const api = new ApiSports(cfg.api_football, APIB_BASE, 'API-Basketball'), porFecha = {};
    for (const i of bas) (porFecha[ymd(i.hora)] = porFecha[ymd(i.hora)] || []).push(i);
    for (const [fecha, grupo] of Object.entries(porFecha)) {
      const k = 'basket_' + fecha;
      let juegos = Store.get(k);
      if (!juegos) { juegos = (await api._get('/games', {date: fecha, timezone: TZ})) || []; if (fecha < ymd(new Date())) Store.set(k, juegos); }
      for (const i of grupo) {
        let mejor = null, p = 0.6;
        for (const j of juegos) { const s = (sim(i.local, j.teams.home.name) + sim(i.visita, j.teams.away.name)) / 2; if (s > p) { mejor = j; p = s; } }
        if (!mejor) continue;
        const st = mejor.status.short;
        if (['FT', 'AOT'].includes(st)) { const h = mejor.scores.home.total, a = mejor.scores.away.total, g = gana(i.opcion, h, a); out[i.id] = [g == null ? 'nula' : g ? 'ganada' : 'perdida', `${h}-${a}`]; }
        else if (['POST', 'CANC', 'ABD', 'AWD'].includes(st)) out[i.id] = ['nula', st];
      }
    }
  }
  return out;
}

/* ---------------------------------------------------------------- historial */
const Historial = {
  _ult: 0,
  lista() { return Store.get('historial', []); },
  _guardar(l) { Store.set('historial', l); },
  _liquidar(a, estado, marcador = null) {
    a.estado = estado; a.marcador = marcador; a.resuelta = new Date().toISOString();
    a.ganancia = estado === 'ganada' ? Math.round(a.monto * (a.cuota - 1)) : estado === 'perdida' ? -Math.round(a.monto) : 0;
  },
  agregar(d) {
    for (const k of ['local', 'visita', 'opcion', 'sel', 'p', 'cuota', 'monto', 'hora']) if (d[k] == null || d[k] === '') throw new ErrorUsuario('Faltan datos para registrar la apuesta.');
    if (!(d.cuota > 1)) throw new ErrorUsuario('La cuota debe ser mayor que 1.');
    if (!(d.monto > 0)) throw new ErrorUsuario('El monto debe ser mayor que 0.');
    const l = this.lista();
    l.push({id: Math.random().toString(36).slice(2, 12), registrada: new Date().toISOString(), liga: d.liga || '', local: d.local, visita: d.visita,
      hora: d.hora, fixture_id: d.fixture_id || null, deporte: d.deporte || 'futbol', opcion: d.opcion, mercado: d.mercado || '', sel: d.sel,
      p: Number(d.p), cuota: Number(d.cuota), monto: Math.round(d.monto), estado: 'pendiente', ganancia: 0, marcador: null});
    this._guardar(l);
  },
  borrar(id) { this._guardar(this.lista().filter(a => a.id !== id)); },
  resolverManual(id, estado) {
    const l = this.lista();
    for (const a of l) if (a.id === id) {
      if (estado === 'pendiente') Object.assign(a, {estado: 'pendiente', ganancia: 0, marcador: null, resuelta: null});
      else { this._liquidar(a, estado); a.manual = true; }
    }
    this._guardar(l);
  },
  async revisar(forzar) {
    if (!forzar && Date.now() - this._ult < 6e5) return null;
    this._ult = Date.now();
    if (!leerConfig().api_football) return 'Sin clave de API-Football: marca los resultados a mano.';
    let res;
    try { res = await resolver(this.lista().filter(a => a.estado === 'pendiente')); }
    catch (e) { return e.bloqueo ? 'API-Football no permite la conexión directa desde el celular: marca los resultados a mano.' : 'No pude revisar los resultados: ' + e.message; }
    if (Object.keys(res).length) { const l = this.lista(); for (const a of l) if (a.estado === 'pendiente' && res[a.id]) this._liquidar(a, ...res[a.id]); this._guardar(l); }
    return null;
  },
  resumen() {
    const cfg = leerConfig(), l = this.lista(), res = l.filter(a => a.estado === 'ganada' || a.estado === 'perdida');
    const neto = l.reduce((s, a) => s + (a.ganancia || 0), 0), apostado = res.reduce((s, a) => s + a.monto, 0);
    const pend = l.filter(a => a.estado === 'pendiente');
    return {banca_inicial: cfg.banca, banca_actual: Math.round(cfg.banca + neto), ganancia: Math.round(neto),
      rendimiento: apostado ? neto / apostado : null, n_resueltas: res.length, n_pendientes: pend.length,
      acierto: res.length ? res.filter(a => a.estado === 'ganada').length / res.length : null,
      apuestas: [...l].sort((a, b) => a.registrada < b.registrada ? 1 : -1)};
  },
};

/* ---------------------------------------------------------------- seguimiento de recomendaciones */
const APUESTA_SIM = 1000, MIN_GRUPO = 30;
const riesgoTxt = p => p >= 0.75 ? 'Riesgo bajo' : p >= 0.55 ? 'Riesgo medio' : 'Riesgo alto';
const tramoCuota = c => c == null ? 'Sin cuota de referencia' : c < 1.5 ? 'Menos de 1,50' : c < 2 ? '1,50 a 1,99' : c < 2.5 ? '2,00 a 2,49' : '2,50 o más';
const Seguimiento = {
  _ult: 0, aviso: null,
  datos() { return Store.get('seguimiento', {}); },
  registrar(an) {
    if (an.demo) return;
    const cfg = leerConfig(), d = this.datos(), ahora = Date.now();
    for (const p of an.partidos) {
      if (p.deporte === 'tenis' || new Date(p.hora).getTime() <= ahora) continue;
      const [primera, mejores] = seleccion(p, cfg); if (!primera) continue;
      const nuevas = {};
      for (const [c, grupo] of [[primera, 'Opción 1'], ...mejores.map(m => [m, 'Riesgo bajo con valor'])]) {
        const k = p.key + '|' + c.id;
        const e = nuevas[k] || {id: k, partido: p.key, deporte: p.deporte, competicion: p.competicion, liga: p.liga, local: p.local, visita: p.visita,
          hora: p.hora, fixture_id: p.fixture_id, fuente: p.fuente, opcion: c.id, familia: c.familia, mercado: c.mercado, sel: c.sel, p: c.p,
          cuota: c.mejor, ev: c.ev, valor: !!c.valor, confianza: (p.confianza || {}).nivel, grupos: [], estado: 'pendiente', marcador: null, actualizado: new Date().toISOString()};
        if (!e.grupos.includes(grupo)) e.grupos.push(grupo);
        nuevas[k] = e;
      }
      for (const k of Object.keys(d)) if (d[k].partido === p.key && d[k].estado === 'pendiente') delete d[k];
      Object.assign(d, nuevas);
    }
    Store.set('seguimiento', d);
  },
  async revisar(forzar) {
    if (!forzar && Date.now() - this._ult < 6e5) return;
    this._ult = Date.now();
    const d = this.datos(), pend = Object.values(d).filter(v => v.estado === 'pendiente');
    if (!pend.length) return;
    let res;
    try { res = await resolver(pend); this.aviso = null; }
    catch (e) { this.aviso = e.bloqueo ? 'API-Football no permite la conexión directa desde el celular, así que los resultados no se revisan solos en esta versión.' : 'No pude revisar los resultados: ' + e.message; return; }
    const lim = Date.now() - 3 * 864e5;
    for (const [k, v] of Object.entries(d)) {
      if (v.estado !== 'pendiente') continue;
      if (res[k]) [v.estado, v.marcador] = res[k];
      else if (new Date(v.hora).getTime() < lim) v.estado = 'sin_resultado';
    }
    Store.set('seguimiento', d);
  },
  _gan(v) { if (v.cuota == null) return null; return v.estado === 'ganada' ? APUESTA_SIM * (v.cuota - 1) : v.estado === 'perdida' ? -APUESTA_SIM : 0; },
  _grupo(items) {
    const n = items.length, ac = items.filter(v => v.estado === 'ganada').length, cc = items.filter(v => v.cuota != null);
    const gan = cc.reduce((s, v) => s + this._gan(v), 0);
    return {n, aciertos: ac, errores: n - ac, acierto: n ? ac / n : null, estimada: n ? items.reduce((s, v) => s + v.p, 0) / n : null,
      ganancia: Math.round(gan), n_con_cuota: cc.length, rendimiento: cc.length ? gan / (APUESTA_SIM * cc.length) : null};
  },
  estadisticas() {
    const todos = Object.values(this.datos()), res = todos.filter(v => v.estado === 'ganada' || v.estado === 'perdida');
    const DIM = [['deporte', 'Deporte', v => DEPORTES[v.deporte] || v.deporte], ['liga', 'Liga', v => v.liga], ['mercado', 'Mercado', v => v.mercado],
      ['riesgo', 'Nivel de riesgo', v => riesgoTxt(v.p)], ['fuente', 'Fuente de la probabilidad', v => v.fuente],
      ['tramo', 'Tramo de cuota', v => tramoCuota(v.cuota)], ['confianza', 'Confianza del análisis', v => v.confianza || 'Sin dato'],
      ['grupo', 'Tipo de recomendación', null]];
    const out = {total: this._grupo(res), pendientes: todos.filter(v => v.estado === 'pendiente').length,
      nulas: todos.filter(v => v.estado === 'nula' || v.estado === 'sin_resultado').length, apuesta_simulada: APUESTA_SIM,
      min_grupo: MIN_GRUPO, aviso: this.aviso, desglose: [], calibracion: []};
    for (const [clave, titulo, fn] of DIM) {
      const g = {};
      for (const v of res) for (const nom of (clave === 'grupo' ? v.grupos || [] : [fn(v)])) (g[nom] = g[nom] || []).push(v);
      out.desglose.push({clave, titulo, filas: Object.entries(g).map(([nombre, it]) => Object.assign(this._grupo(it), {nombre})).sort((a, b) => b.n - a.n)});
    }
    for (const [lo, hi, nombre] of [[0, .4, 'Menos de 40%'], [.4, .5, '40% a 50%'], [.5, .6, '50% a 60%'], [.6, .7, '60% a 70%'], [.7, .8, '70% a 80%'], [.8, .9, '80% a 90%'], [.9, 1.01, '90% o más']]) {
      const g = res.filter(v => v.p >= lo && v.p < hi); if (g.length) out.calibracion.push(Object.assign(this._grupo(g), {nombre}));
    }
    out.peores = res.filter(v => v.estado === 'perdida').sort((a, b) => b.p - a.p).slice(0, 10);
    out.mejores = res.filter(v => v.estado === 'ganada').sort((a, b) => a.p - b.p).slice(0, 10);
    out.sugerencias = this.sugerencias(out);
    return out;
  },
  sugerencias(st) {
    if (st.total.n < MIN_GRUPO) return [`Aún hay ${st.total.n} recomendaciones con resultado. Las sugerencias aparecen cuando un grupo reúne al menos ${MIN_GRUPO}, para no dejarse engañar por una racha.`];
    const s = [], P = x => Math.round(x * 100) + '%';
    for (const dim of st.desglose) {
      if (dim.clave === 'grupo') continue;
      for (const f of dim.filas) {
        if (f.n < MIN_GRUPO) continue;
        const dif = f.acierto - f.estimada, et = `${dim.titulo.toLowerCase()} «${f.nombre}»`;
        if (dif <= -0.06) {
          const c = {fuente: 'Conviene darle menos peso a las estadísticas (subir el peso del mercado).', mercado: 'Considera exigir más ventaja en este mercado o dejar de recomendarlo.',
            tramo: 'Considera excluir este tramo de cuotas.', liga: 'En esta liga conviene confiar más en el mercado que en el modelo.'}[dim.clave] || 'Conviene exigir más ventaja mínima en este grupo.';
          s.push(`El modelo sobreestima en ${et}: estima ${P(f.estimada)} y acierta ${P(f.acierto)} (${f.n} resultados). ${c}`);
        } else if (dif >= 0.06) s.push(`El modelo subestima en ${et}: estima ${P(f.estimada)} y acierta ${P(f.acierto)} (${f.n} resultados). Puede haber valor que la app no está viendo.`);
        if (f.rendimiento != null && f.n_con_cuota >= MIN_GRUPO && f.rendimiento < -0.1) s.push(`En ${et} se pierde dinero: ${Math.round(f.rendimiento * 100)}% por apuesta. Considera dejar de apostar en este grupo.`);
      }
    }
    return s.length ? s : ['Con los datos actuales no se ven desviaciones importantes: el modelo está bien calibrado.'];
  },
  informe() {
    const cfg = leerConfig(), st = this.estadisticas(), t = st.total, pc = x => x == null ? '—' : (x * 100).toFixed(1).replace('.', ',') + '%';
    const L = [`INFORME RADAR DE APUESTAS (CELULAR) · ${new Date().toLocaleString('es-CL', {timeZone: TZ})}`, '', 'AJUSTES ACTUALES',
      `- Probabilidad mínima: ${Math.round(cfg.prob_min * 100)}% · ventaja mínima: ${(cfg.ev_min * 100).toFixed(1)}% · peso del mercado: ${Math.round(cfg.peso_mercado * 100)}% · cuota mínima: ${cfg.cuota_min_pick} · fracción de Kelly: ${cfg.kelly} · mínimo de casas: ${cfg.min_casas}`,
      `- Competiciones activas: ${cfg.ligas.map(c => COMPETICIONES[c].nombre).join(', ')}`, '',
      'RESUMEN DE RECOMENDACIONES (opción 1 y riesgo bajo con valor, apostadas o no)',
      `- Con resultado: ${t.n} · aciertos: ${t.aciertos} · errores: ${t.errores} · acierto: ${pc(t.acierto)} · probabilidad estimada media: ${pc(t.estimada)}`,
      `- Ganancia simulada apostando $${APUESTA_SIM} en cada una con cuota: $${t.ganancia.toLocaleString('es-CL')} (${t.n_con_cuota} apuestas, rendimiento ${pc(t.rendimiento)})`,
      `- Pendientes: ${st.pendientes} · nulas o sin resultado: ${st.nulas}`, '', 'CALIBRACIÓN (probabilidad estimada vs acierto real)'];
    for (const f of st.calibracion) L.push(`- ${f.nombre}: ${f.n} · estimada ${pc(f.estimada)} · real ${pc(f.acierto)} · rendimiento ${pc(f.rendimiento)}`);
    for (const d of st.desglose) { L.push('', d.titulo.toUpperCase()); for (const f of d.filas) L.push(`- ${f.nombre}: ${f.n} · acierto ${pc(f.acierto)} · estimada ${pc(f.estimada)} · rendimiento ${pc(f.rendimiento)}`); }
    L.push('', 'FALLOS MÁS CONFIADOS'); for (const v of st.peores) L.push(`- ${v.local} vs ${v.visita} (${v.liga}): ${v.sel} · estimada ${pc(v.p)} · cuota ${v.cuota || '—'} · marcador ${v.marcador} · fuente ${v.fuente}`);
    L.push('', 'ACIERTOS MÁS DIFÍCILES'); for (const v of st.mejores) L.push(`- ${v.local} vs ${v.visita} (${v.liga}): ${v.sel} · estimada ${pc(v.p)} · cuota ${v.cuota || '—'} · marcador ${v.marcador}`);
    L.push('', 'SUGERENCIAS DE LA APP', ...st.sugerencias.map(x => '- ' + x), '', 'Pedido: revisa estos resultados y propón ajustes al Radar de Apuestas.');
    return L.join('\n');
  },
};

/* ---------------------------------------------------------------- análisis con caché */
const CACHE_MIN = 60;
function cacheFresco(rango) {
  const d = Store.get('analisis_' + rango);
  if (!d || d.version !== 2) return null;
  if (ymd(d.generado_ts * 1000) !== ymd(new Date()) || Date.now() / 1000 - d.generado_ts > CACHE_MIN * 60) return null;
  return Object.assign(d, {desde_cache: true});
}
async function analisisRango(rango, forzar, demo, log) {
  if (demo) return correr(rango, true, log);
  if (!forzar) { const c = cacheFresco(rango); if (c) return c; }
  const d = await correr(rango, false, log);
  Store.set('analisis_' + rango, d);
  try { Seguimiento.registrar(d); } catch (e) { console.error(e); }
  return d;
}
async function analisis(rango, forzar, demo, log) {
  if (rango !== 'auto') return analisisRango(rango, forzar, demo, log);
  let d = await analisisRango('hoy', forzar, demo, log);
  if (!d.partidos.length) {
    d = await analisisRango('manana', forzar, demo, log);
    d = Object.assign({}, d, {avisos: ['Ya no quedan partidos por jugar hoy: te muestro los de mañana.', ...d.avisos]});
  }
  return d;
}
function borrarCacheAnalisis() { for (const r of Object.keys(RANGOS)) Store.del('analisis_' + r); }

/* ---------------------------------------------------------------- datos de ejemplo */
function datosDemo(rango) {
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const [ini, fin] = ventana(rango), hoy0 = inicioDia(new Date());
  const CASAS = [['pinnacle', 'Pinnacle', .025], ['betfair_ex_eu', 'Betfair', .03], ['bet365', 'Bet365', .06], ['williamhill', 'William Hill', .07],
    ['betsson', 'Betsson', .055], ['unibet_eu', 'Unibet', .06], ['marathonbet', 'Marathonbet', .045], ['1xbet', '1xBet', .05]];
  const precio = (p, mg, s) => Math.max(1.01, Math.round(1 / (p * (1 + mg)) * (1 + s) * 100) / 100);
  const ses = k => (rnd() - .5) * .06 + (k === 'marathonbet' ? .03 : 0);
  const cuando = (d, h) => new Date(hoy0.getTime() + d * 864e5 + h * 3600e3);
  const enRango = t => t >= ini && t <= fin;
  const FUT = [['premier', 'Arsenal', 'Brentford', 2.1, .8, 0, 23, 1, 1], ['chile', 'Colo-Colo', 'Ñublense', 1.85, .85, 1, 18, 1, 1],
    ['chile', 'Universidad Católica', 'Universidad de Chile', 1.3, 1.15, 1, 20, 1, 1], ['libertadores', 'Flamengo', 'Racing Club', 1.6, .9, 1, 21, 1, 1],
    ['sudamericana', 'Lanús', 'Atlético Mineiro', 1.2, 1.1, 1, 19, 0, 0], ['laliga', 'Real Sociedad', 'Getafe', 1.25, .75, 2, 15, 1, 1],
    ['chile', 'Cobresal', 'Everton', 1.4, 1.05, 2, 17, 0, 1], ['mexico', 'América', 'Pumas', 1.7, 1, 2, 22, 1, 1],
    ['seriea', 'Inter', 'Lecce', 2.2, .6, 3, 16, 1, 1], ['bundesliga', 'Bayer Leverkusen', 'Mainz', 1.9, 1, 5, 11, 1, 1]];
  const eventos = [], fixtures = [], tb = {};
  FUT.forEach(([liga, loc, vis, lh, la, d, h, cc, ct], n) => {
    const t = cuando(d, h); if (!enRango(t)) return;
    const p = probsDeMatriz(matriz(lh, la), [2.5]), lid = COMPETICIONES[liga].apif;
    fixtures.push({fixture: {id: 1000 + n, date: t.toISOString(), status: {short: 'NS'}}, league: {id: lid, season: 2026}, teams: {home: {id: 2 * n + 1, name: loc}, away: {id: 2 * n + 2, name: vis}}});
    if (cc) eventos.push([liga, {id: 'e' + n, commence_time: t.toISOString(), home_team: loc, away_team: vis, bookmakers: CASAS.map(([k, ti, mg]) => ({key: k, title: ti, markets: [
      {key: 'h2h', outcomes: [{name: loc, price: precio(p['1'], mg, ses(k))}, {name: 'Draw', price: precio(p.X, mg, ses(k))}, {name: vis, price: precio(p['2'], mg, ses(k))}]},
      {key: 'totals', outcomes: [{name: 'Over', point: 2.5, price: precio(p['over_2.5'], mg, ses(k))}, {name: 'Under', point: 2.5, price: precio(p['under_2.5'], mg, ses(k))}]}]}))}]);
    if (ct) {
      const k = lid + '|2026', u = (a, b) => a + rnd() * (b - a);
      (tb[k] = tb[k] || []).push(
        {team: {id: 2 * n + 1, name: loc}, home: {played: 12, goals: {for: Math.round(lh * 12 * u(.85, 1.2)), against: Math.round(la * 12 * u(.8, 1.2))}}, away: {played: 12, goals: {for: Math.round(lh * 9 * u(.8, 1.2)), against: Math.round(la * 14)}}},
        {team: {id: 2 * n + 2, name: vis}, home: {played: 12, goals: {for: Math.round(la * 15 * u(.8, 1.2)), against: Math.round(lh * 10)}}, away: {played: 12, goals: {for: Math.round(la * 12 * u(.85, 1.2)), against: Math.round(lh * 12 * u(.8, 1.2))}}});
    }
  });
  [['Boston Celtics', 'Charlotte Hornets', .82, -10.5, 221.5, 0, 20], ['Denver Nuggets', 'Los Angeles Lakers', .58, -2.5, 229.5, 1, 22], ['Miami Heat', 'New York Knicks', .46, 1.5, 214.5, 2, 20]]
    .forEach(([loc, vis, p1, hcp, tot, d, h], n) => {
      const t = cuando(d, h); if (!enRango(t)) return;
      eventos.push(['nba', {id: 'b' + n, commence_time: t.toISOString(), sport_title: 'NBA', home_team: loc, away_team: vis, bookmakers: CASAS.map(([k, ti, mg]) => ({key: k, title: ti, markets: [
        {key: 'h2h', outcomes: [{name: loc, price: precio(p1, mg, ses(k))}, {name: vis, price: precio(1 - p1, mg, ses(k))}]},
        {key: 'spreads', outcomes: [{name: loc, point: hcp, price: precio(.5, mg, ses(k))}, {name: vis, point: -hcp, price: precio(.5, mg, ses(k))}]},
        {key: 'totals', outcomes: [{name: 'Over', point: tot, price: precio(.5, mg, ses(k))}, {name: 'Under', point: tot, price: precio(.5, mg, ses(k))}]}]}))}]);
    });
  [['ATP Paris Masters', 'Carlos Alcaraz', 'Ugo Humbert', .84, 1, 9], ['ATP Paris Masters', 'Taylor Fritz', 'Holger Rune', .55, 1, 12], ['WTA Finals', 'Aryna Sabalenka', 'Jasmine Paolini', .76, 2, 11]]
    .forEach(([tor, j1, j2, p1, d, h], n) => {
      const t = cuando(d, h); if (!enRango(t)) return;
      eventos.push([tor.startsWith('WTA') ? 'tenis_wta' : 'tenis_atp', {id: 't' + n, commence_time: t.toISOString(), sport_title: tor, home_team: j1, away_team: j2,
        bookmakers: CASAS.slice(0, 6).map(([k, ti, mg]) => ({key: k, title: ti, markets: [{key: 'h2h', outcomes: [{name: j1, price: precio(p1, mg, ses(k))}, {name: j2, price: precio(1 - p1, mg, ses(k))}]}]}))}]);
    });
  const tablas = {}; for (const [k, v] of Object.entries(tb)) tablas[k] = statsDesdeTabla([{league: {standings: [v]}}]);
  return {eventos, fixtures, tablas};
}

if (typeof module !== 'undefined') module.exports = {confianza, factorForma, consenso, analizarFutbol, analizarMercado, seleccion, probsDeMatriz, matriz, ajustarLambdas,
  gana, sim, ventana, datosDemo, construirPartidos, leerConfig, Seguimiento, Historial, Store, COMPETICIONES, ymd, inicioDia};
