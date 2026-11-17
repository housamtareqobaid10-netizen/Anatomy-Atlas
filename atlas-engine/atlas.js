// The 3D atlas engine: the code that runs the atlases on samplesize1.com/tools, in one place.
// (All ten run on it.)
//
// An atlas is a page with the markup this code fills in (found by id), its data (data.js), its model (.glb)
// and a call to startAtlas({ ... }) with the settings that make it that atlas: its zoom areas, colours,
// voice words and so on. Each setting is explained where it is read, below; any atlas's index.html shows a full set.
//
// A change here changes every atlas that runs on it. tests/atlas/ uses each atlas step by step and compares what
// it did with a saved record, so a change in behaviour shows up there.

// For the zoom areas in an atlas's settings: an area that is only some parts of a region (match: subIn('chest', 'pelvis'))
// or only some of its units (match: unitIn(['arcuate_a', ...], 'lowerleg')), or all of a region but some parts
// (match: notIn('hand')). A piece of the frame (a bone) lists every part it belongs to, and matches if any of them does.
export const subIn = (...subs) => (d) => d.subs ? d.subs.some(s => subs.includes(s)) : subs.includes(d.sub);
export const notIn = (...subs) => (d) => !(d.subs || [d.sub]).some(s => subs.includes(s));
// ...or by the part of the body a piece is in, where the data gives each piece an `area` (match: areaIs('head', 'neck'))
export const areaIs = (...areas) => (d) => areas.includes(d.area);
export const unitIn = (units, ...subs) => { const set = new Set(units); return (d) => d.subs ? d.subs.some(s => subs.includes(s)) : set.has(d.unit); };

import { UI as ENGINE_UI, LANGS as ENGINE_LANGS } from './text.js';
import { answersFor, judge, hintSlots, titleCase, HINTS } from './answers.js';

export async function startAtlas(settings) {
  // three.js ships next to this file (three-bundle.js). If it can't be loaded, fall back to the public CDN
  // (the page's import map says where).
  async function loadLib() {
    try {
      return await import('./three-bundle.js');
    } catch (e) {
      console.warn('Local three.js bundle failed to load, trying the CDN.', e);
      const THREE = await import('three');
      const [{ GLTFLoader }, { OrbitControls }, { RoomEnvironment }, { MeshoptDecoder }] = await Promise.all([
        import('three/addons/loaders/GLTFLoader.js'),
        import('three/addons/controls/OrbitControls.js'),
        import('three/addons/environments/RoomEnvironment.js'),
        import('three/addons/libs/meshopt_decoder.module.js'),
      ]);
      return { THREE, GLTFLoader, OrbitControls, RoomEnvironment, MeshoptDecoder };
    }
  }
  // The page's words (/js/language.js, which the page started): the atlas's own (DATA.ui, and lang/<code>.json in its
  // folder) over the engine's (text.js, and lang/<code>.json here). Loaded while three.js loads.
  const langReady = SiteLanguage.open({ layers: [
    { text: settings.data.ui, files: new URL('lang/', document.baseURI) },
    { text: ENGINE_UI, files: new URL('lang/', import.meta.url), has: ENGINE_LANGS },
  ] });
  const [{ THREE, GLTFLoader, OrbitControls, RoomEnvironment, MeshoptDecoder }, lang] = await Promise.all([loadLib().catch((err) => {
    document.getElementById('loadMsg').textContent = SiteLanguage.bootText('engine_fail');
    window.__atlasFatal = true;
    throw err;
  }), langReady]);
  window.__atlasStarted = true;

  const DATA = settings.data;
  // An atlas's own code (settings.extend: the Engine's taking apart and running, the Brain's look inside) is called at
  // fixed points, through this.
  // It is started further down, once everything it may use exists; until then nothing is called.
  let own = {};
  // The model ships as a .glb on a normal website. Where only text files can be hosted it ships as
  // base64 text ('…-glb.txt'), which is decoded here before parsing.
  // The model is meshopt-compressed; MeshoptDecoder unpacks it.
  const MODEL_URL = settings.model;
  const MODEL_BYTES = settings.modelBytes;   // lets the loading bar show progress
  const $ = (id) => document.getElementById(id);

  /* ---------------- storage (per-browser, optional) ---------------- */
  // Saved through the site-wide helper (/js/progress.js) under the atlas's id. If the helper can't load (e.g. the page
  // opened on its own), it saves straight to this browser instead, under the atlas's own prefix.
  const store = window.SiteProgress ? SiteProgress.tool(settings.id, { legacyPrefix: settings.savedAs }) : {
    get(k, d) { try { const v = localStorage.getItem(settings.savedAs + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(settings.savedAs + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  };

  /* ---------------- data lookups ---------------- */
  const REGION = Object.fromEntries(DATA.regions.map(r => [r.key, r]));
  const SUB = {};
  for (const r of DATA.regions) for (const s of r.subs) SUB[s.key] = { ...s, region: r.key };
  // The names come from Bone Atlas: a "bone" here is one clickable piece of the model (a tooth, a vessel or branch on one
  // side, a node). DATA.groups are the things as taught, with their branches (the Main set quizzes those marked main: any
  // branch of the femoral artery counts as "Femoral artery"); DATA.units are what the All set quizzes: each one on its own.
  const BONE = Object.fromEntries(DATA.bones.map(b => [b.id, b]));
  for (const [k, g] of Object.entries(DATA.groups)) g.key = k;
  for (const [k, u] of Object.entries(DATA.units)) u.key = k;
  const UNIT = DATA.units;

  /* ---------------- language ---------------- */
  // t('key', { name: … }) -> text in the language in use, with {name} filled in ({ one, other } picked by n);
  // pair('one_foot') -> ['Pied gauche', 'Pied droit']. Voice commands stay English-only.
  const t = lang.t, pair = lang.list;
  // the atlas's names in the language in use (lang/<code>.json: units, groups, regions, subs, tips, context), else the English
  const named = () => lang.file(0);
  // [name with hints, anatomical name] for a group, a unit, or a piece (a piece is named after its unit)
  function names(o) {
    if (!o.members) o = UNIT[o.unit];
    const tr = (UNIT[o.key] === o ? named().units : named().groups)?.[o.key];
    return tr ? [tr[0], tr[1] || tr[0]] : [o.name, o.tech || o.name];
  }
  function regionLabel(key) { return named().regions?.[key] || REGION[key].label; }
  // a frame piece's name (a skull bone around the teeth…) in the language in use (lang/<code>.json: context), else the English
  function contextName(c) { return (c.id && named().context?.[c.id]) || c.extra; }
  function subLabel(key) { return named().subs?.[key] || SUB[key].label; }
  // accent- and case-insensitive text for search ("femur" finds "Fémur", "fuss" finds "Fuß")
  const fold = lang.fold;
  // "Left femur" -> "left femur" for use mid-sentence (accented capitals too: "Fémur" -> "fémur"); "C3 vertebra" stays.
  // German keeps its capitals: nouns and the Latin names are always capitalised.
  const lowerFirst = lang.midSentence;
  // What a click on something that isn't one of the atlas's pieces says: the bone, the brain, an eyeball... is named.
  // (an atlas whose frame has other kinds of pieces says what a click on one shows: settings.contextNote)
  function contextNote(c) {
    if (settings.contextNote) return settings.contextNote(c, { t, lowerFirst, DATA, contextName });
    if (c.kind === 'bone') return t('ctx_bone', { name: lowerFirst(contextName(c)) });
    if (c.kind === 'cns' && c.extra === 'brain') return t('ctx_cns', { name: contextName(c) });
    if (c.extra) return t('ctx_organ', { name: lowerFirst(contextName(c)) });
    return t('ctx_other');
  }
  // The frame (bones, organs...) is drawn as a ghost and blocks no click: a click lands on the nearest piece. Only when
  // no piece is anywhere near does the frame piece under the cursor get named (pickAt). An atlas whose frame is solid
  // lists the kinds that do block a click: settings.clickableContext = { bone: true }.
  const CONTEXT_CLICKABLE = settings.clickableContext || {};

  /* ---------------- state ---------------- */
  // settings.nameIt: Practice and Test can also ask the other way round. "Find it" is the usual question (a name, and a
  // click on the model); "Name it" shows one piece on its own and its name is typed (see "Name it" below).
  // { rest: how faintly everything else is drawn meanwhile (0 = not at all), faint: the same for kinds of the frame
  // that would otherwise stay solid ({ tendon: 0.2 }), room: how much is seen around the piece (1.8 = nearly twice its
  // own size), near: the least of its area that is kept in view (0.6), color: the piece drawn in this colour instead
  // of its own (where its own is too like the frame's),
  // through: how strongly it shows through the frame in front of it (0.4; 0 = not at all), filler: words that may be
  // left on a typed name ("deltoid muscle"), far: a small piece is never less than 1/far of the picture,
  // infront: how faintly the pieces of the frame standing between the camera and the piece are drawn (0 = not at all),
  // once they hide more than `hidden` of it (0.25): the jaw in front of a tongue muscle, the kneecap in front of a
  // cruciate ligament; around: the same for the frame outside the piece's own part of the map (Joint: only the bones
  // of the ligament's joint stay solid), beside: a function saying how strongly another piece is drawn beside the
  // asked one, where that is more than `rest` (Heart: the rest of the heart round a chamber or a valve),
  // whole: the piece is shown on the one thing it is part of, and nothing else (Bone Landmarks: 'bone', the data's
  // name for it; a landmark on its own bone, one side, with `rest` for every other bone) }.
  // The page has the control (#quizBox) and the answer box (#answer).
  const NAME = settings.nameIt || null;
  const MODE_ALIASES = { learn: 'practice', explore: 'study' };
  const state = {
    mode: MODE_ALIASES[store.get('mode', 'study')] || store.get('mode', 'study'),
    set: store.get('set', 'names'),
    section: store.get('section', 'all'),   // 'all' | region | 'region/sub'
    hints: store.get('hints', false) === true,   // off unless turned on, like the other atlases
    notes: store.get('notes', false) === true,   // Study's lines about a piece (what it does, an injury...): off unless turned on
    ...(settings.bodies ? { sex: store.get('sex', 'M') === 'F' ? 'F' : 'M' } : {}),   // Body (settings.bodies): male or female
    // Find it or Name it (settings.nameIt). Until one is picked: Name it on a wide screen, Find it on a phone, where typing is slower
    ...(NAME ? { quiz: ['find', 'name'].includes(store.get('quiz')) ? store.get('quiz') : (window.innerWidth > 900 ? 'name' : 'find') } : {}),
    view: 'all', viewSide: 'both',          // camera zoom: an area and side to look at, separate from what is being quizzed
    layer: 1,                               // Layers: unused here (every piece is layer 1)
    bones: store.get('bones', true) !== false,
    xray: false, peel: false, clean: false,
    hidden: new Set(),
  };
  if (!['study', 'practice', 'test'].includes(state.mode)) state.mode = 'study';
  if (!['names', 'all'].includes(state.set)) state.set = 'names';
  if (!validSection(state.section)) state.section = 'all';
  const naming = () => !!NAME && state.quiz === 'name' && state.mode !== 'study';

  function parseSection(sec) {
    if (!sec || sec === 'all') return {};
    const [region, sub] = sec.split('/');
    return { region, sub };
  }
  function validSection(sec) {
    if (sec === 'all') return true;
    const p = parseSection(sec);
    return !!REGION[p.region] && (!p.sub || (SUB[p.sub] && SUB[p.sub].region === p.region));
  }
  // A piece has one region and sub. A context piece (a bone) lists every joint it takes part in (subs), so the femur
  // is live for the hip and the knee.
  function inSection(d, sec = state.section) {
    if (sec === 'all') return true;
    const p = parseSection(sec);
    if (d.subs) return p.sub ? d.subs.includes(p.sub) : d.regions.includes(p.region);
    const hit = (r, s) => r === p.region && (!p.sub || s === p.sub);
    return hit(d.region, d.sub) || (!!d.also && hit(d.also.region, d.also.sub));   // also: a piece that belongs to two parts (Organ)
  }
  function inSide(d, side) { return side === 'both' || !d.side || d.side === (side === 'left' ? 'L' : 'R'); }
  // Quizzes always cover both sides. Left / right is a view setting (the Side control in the View card).
  // settings.bodies (Organ): the atlas has a Body control (male / female); a piece or part marked with a sex belongs to that body only
  function inBody(d) { return !settings.bodies || !d.sex || d.sex === state.sex; }
  function inScope(d, sec = state.section) { return inSection(d, sec) && inBody(d); }
  // The zoom areas (settings.zooms: the chips in the View card and the number keys; the first is the whole model).
  // label: the English name, for reading the settings. On screen the name comes from the text table (zoom_<key>).
  // match narrows an area to some of its parts (subIn, unitIn at the top of this file); dir is where the camera looks
  // from (default: the front; a pair [a, b] = a, or b when only the right side is shown); one: the area is framed one
  // side at a time.
  const ZOOMS = settings.zooms;
  // Voice-only zooms (settings.voiceZooms): no chip or number key; while one is on, its parent chip shows as pressed.
  const ZOOMS_VOICE = settings.voiceZooms || [];
  const ZOOM = Object.fromEntries([...ZOOMS, ...ZOOMS_VOICE].map(z => [z.key, z]));
  function inView(d, key = state.view, side = state.viewSide) {
    const z = ZOOM[key];
    return inSection(d, z.sec) && (!z.match || z.match(d)) && inSide(d, side);
  }
  function zoomed() { return state.view !== 'all' || state.viewSide !== 'both' || !!(own.zoomed && own.zoomed()); }
  // (settings.zoomNames = 'regions': the areas are the map's regions and take their names)
  function zoomLabel(key) { return settings.zoomNames === 'regions' ? (key === 'all' ? t('whole_body') : (lang.has('zoom_' + key) ? t('zoom_' + key) : regionLabel(key))) : t('zoom_' + key); }
  function viewLabel(key = state.view, side = state.viewSide) {
    const z = ZOOM[key];
    if (side === 'both') return zoomLabel(key);
    const i = side === 'left' ? 0 : 1;
    return z.one ? pair('one_' + z.one)[i] : pair('side_view')[i].replace('{area}', zoomLabel(key));
  }
  function sectionLabel(sec = state.section) {
    if (sec === 'all') return t('whole_body');
    const p = parseSection(sec);
    return p.sub && !SUB[p.sub].only ? `${regionLabel(p.region)} · ${subLabel(p.sub)}` : regionLabel(p.region);   // (only: a region's single, unlisted part)
  }
  function sectionTip(sec = state.section) {
    const p = parseSection(sec), k = (p.sub && !SUB[p.sub].only ? p.sub : p.region) || 'all';
    return named().tips?.[k] || DATA.tips[k] || '';
  }

  /* ---------------- three.js setup ---------------- */
  const canvas = $('c');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch (e) {
    $('loadMsg').textContent = SiteLanguage.bootText('webgl_fail');
    window.__atlasFatal = true;
    throw e;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  // settings.stage: where an atlas differs in how the scene is set (light: how bright the surroundings are, metal needs
  // something to reflect; near, far and maxDistance: for a bigger model; maxZoomOut: how far zooming out goes, as a
  // multiple of the distance that fits the whole model, instead of maxDistance; where the camera starts; startView: the
  // side it starts on when that isn't the usual view, so it swings round as the page opens; startInPlace: it starts at
  // the first view instead of flying to it)
  const STAGE = { light: 0.5, near: 0.005, far: 40, maxDistance: 6, camera: [0, 1.0, 4.2], target: [0, 0.85, 0], ...settings.stage };
  scene.environmentIntensity = STAGE.light;

  const camera = new THREE.PerspectiveCamera(32, 1, STAGE.near, STAGE.far);
  scene.add(camera);
  // Studio lights ride with the camera so every angle is lit the same way.
  const key = new THREE.DirectionalLight(0xfff3e2, 1.9); key.position.set(0.9, 1.3, 1.0);
  const rim = new THREE.DirectionalLight(0x86dcf0, 1.4); rim.position.set(-1.2, 0.6, -1.4);
  const lightTarget = new THREE.Object3D(); lightTarget.position.set(0, 0, -1);
  key.target = lightTarget; rim.target = lightTarget;
  camera.add(key, rim, lightTarget);
  scene.add(new THREE.HemisphereLight(0xe4ecf2, 0x161e25, 0.55));

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.09;
  controls.zoomToCursor = true;
  controls.minDistance = 0.05;
  controls.maxDistance = STAGE.maxDistance;
  controls.rotateSpeed = 0.75;
  controls.screenSpacePanning = true;
  camera.position.set(...STAGE.camera);
  controls.target.set(...STAGE.target);

  /* platform: radiograph-style floor with L / R markers (anatomical left/right), lettered in the current language */
  const floor = { cv: document.createElement('canvas'), tex: null };
  function makePlatform() {
    floor.cv.width = floor.cv.height = 1024;
    floor.tex = new THREE.CanvasTexture(floor.cv); floor.tex.colorSpace = THREE.SRGBColorSpace; floor.tex.anisotropy = 4;
    drawPlatform();
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.5), new THREE.MeshBasicMaterial({ map: floor.tex, transparent: true, depthWrite: false }));
    m.rotation.x = -Math.PI / 2; m.position.y = 0.002; m.renderOrder = -1;
    return m;
  }
  function placePlatform(box) {   // settings.floor = 'fitted': sized to the model and set just under it
    const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    platform.scale.setScalar(2.3 * Math.max(size.x, size.z) / 1.5);
    platform.position.set(c.x, box.min.y - 0.012, c.z);
  }
  function drawPlatform() {
    const S = 1024, cv = floor.cv;
    const g = cv.getContext('2d'), c = S / 2;
    g.clearRect(0, 0, S, S);
    const grad = g.createRadialGradient(c, c, 0, c, c, c);
    grad.addColorStop(0, 'rgba(111,208,232,0.16)'); grad.addColorStop(0.55, 'rgba(111,208,232,0.05)'); grad.addColorStop(1, 'rgba(111,208,232,0)');
    g.fillStyle = grad; g.fillRect(0, 0, S, S);
    g.strokeStyle = 'rgba(140,200,220,0.28)'; g.lineWidth = 2;
    for (const r of [0.62, 0.86]) { g.beginPath(); g.arc(c, c, c * r, 0, Math.PI * 2); g.stroke(); }
    for (let a = 0; a < 360; a += 10) {
      const rad = a * Math.PI / 180, r1 = c * 0.86, r2 = c * (a % 30 === 0 ? 0.81 : 0.835);
      g.beginPath(); g.moveTo(c + Math.cos(rad) * r1, c + Math.sin(rad) * r1); g.lineTo(c + Math.cos(rad) * r2, c + Math.sin(rad) * r2); g.stroke();
    }
    const marker = (txt, x, y) => {
      g.save(); g.translate(x, y);
      g.fillStyle = 'rgba(236,222,194,0.92)'; g.fillRect(-34, -34, 68, 68);
      g.fillStyle = '#0a0f14'; g.font = '800 50px Archivo, Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(txt, 0, 3); g.restore();
    };
    marker(t('floor_l'), c + c * 0.74, c);   // +X = the skeleton's left
    marker(t('floor_r'), c - c * 0.74, c);   // -X = the skeleton's right
    g.fillStyle = 'rgba(160,190,205,0.75)'; g.font = '600 26px "IBM Plex Mono", monospace'; g.textAlign = 'center';
    if (settings.floor === 'fitted') g.textBaseline = 'middle';   // (there the word sits centred on its line)
    g.fillText(t('floor_ant'), c, c + c * 0.75);
    if (floor.tex) floor.tex.needsUpdate = true;
  }
  // (settings.floor: false = no floor, where its L / R markers would float beside the model or mean nothing;
  // 'fitted' = a floor the size of the model, just under it, for a model that isn't standing on the ground: the brain)
  const platform = settings.floor === false ? null : makePlatform(); if (platform) scene.add(platform);

  /* ---------------- materials ---------------- */
  // settings.colors: a colour for each kind of piece (a unit's tint in the data picks one; settings.tint is the usual one).
  const MISS = { flash: 0xff6b5b, review: 0xff7a6b, ...settings.missColors };
  const COL = {
    ...settings.colors,
    // (settings.missColors: an atlas whose pieces are red marks a miss in amber instead: the flash, and the review tint)
    scan: new THREE.Color(0x6fd0e8), ok: new THREE.Color(0x4fd18f), bad: new THREE.Color(MISS.flash),
  };
  // A piece's colour: its own or its unit's where the data gives one, its material's where the data has a palette
  // (DATA.palette: each piece names a material: colour c, roughness r, metalness m), else its unit's tint
  const PALETTE = DATA.palette;
  const pieceColor = (d) => d.color || UNIT[d.unit].color || (PALETTE ? PALETTE[d.mat].c : COL[UNIT[d.unit].tint || settings.tint]);
  // settings.solid (Brain): the pieces fit together into one solid thing, so nothing is drawn see-through (X-ray aside).
  // The piece being shown glows in its own colour while the rest go dark, instead of a highlight seen through
  // everything; a piece outside the chosen part turns grey instead of fading; one outside the zoom area isn't drawn;
  // nothing fades for being in front (the atlas's own views open the model up instead); and pointing at a piece lights
  // all of what a click on it would pick.
  const SOLID = settings.solid === true;
  const overlayMat = new THREE.MeshBasicMaterial({ color: 0x6fd0e8, transparent: true, opacity: settings.highlightOpacity || 0.55, depthTest: false, depthWrite: false });
  // settings.context: the frame the pieces sit in, by kind (bone, cns, organ...): its material. With an opacity it is a
  // ghost, see-through enough that a piece behind it still reads; without one it is solid (the skeleton in Joint Atlas).
  // Two things a kind can say that are not about its material: order (when it is drawn: -2 = before everything) and
  // rays: false (it is left out of everything that looks along a line of sight: clicks, what is in front of what).
  // And outlined: true, for a ghost with many folds (the brain in the Nerve and Heart atlases). Drawn like the others,
  // every fold behind the first adds another see-through layer, and the brain becomes a pink fog. Outlined, only its
  // nearest surface is drawn (its depth is laid down first, by a copy that draws nothing else), after the pieces so
  // that what is inside it still shows. outlined: 'edges' also draws that surface faint where it faces the viewer and
  // stronger toward the edge of each fold, which picks the folds out (tried on the brain: it showed up every facet of
  // the model, and looked jagged).
  // One layer shows what the fog hid: a part of the mesh that is inside out. Z-Anatomy's brain has one hemisphere (and
  // half of the cerebellum) that is the mirror of the other with its faces left pointing inward, so the nearest
  // surface drawn there was the far wall, seen from inside: jagged and hollow. Each connected part of the mesh whose
  // faces enclose a negative volume is turned the right way out (its triangles' order and its normals).
  function faceOutward(geometry) {
    const pos = geometry.attributes.position, nor = geometry.attributes.normal, index = geometry.index;
    if (!index || !nor) return;
    const part = Array.from({ length: pos.count }, (_, i) => i);
    const find = (i) => { while (part[i] !== i) i = part[i] = part[part[i]]; return i; };
    const ix = index.array;
    for (let i = 0; i < ix.length; i += 3) { const a = find(ix[i]); part[find(ix[i + 1])] = a; part[find(ix[i + 2])] = a; }
    const sums = new Map();   // per part: the sum of its triangles' corners (for a middle), then its volume
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      const k = find(i), s = sums.get(k) || { mid: new THREE.Vector3(), n: 0, volume: 0 };
      s.mid.add(a.fromBufferAttribute(pos, i)); s.n++; sums.set(k, s);
    }
    for (const s of sums.values()) s.mid.divideScalar(s.n);
    for (let i = 0; i < ix.length; i += 3) {
      const s = sums.get(find(ix[i]));
      a.fromBufferAttribute(pos, ix[i]).sub(s.mid); b.fromBufferAttribute(pos, ix[i + 1]).sub(s.mid); c.fromBufferAttribute(pos, ix[i + 2]).sub(s.mid);
      s.volume += a.dot(b.cross(c));
    }
    let turned = false;
    for (let i = 0; i < ix.length; i += 3) if (sums.get(find(ix[i])).volume < 0) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; turned = true; }
    if (!turned) return;
    const top = nor.array instanceof Int8Array ? 127 : nor.array instanceof Int16Array ? 32767 : Infinity, n = nor.array;
    for (let i = 0; i < pos.count; i++) if (sums.get(find(i)).volume < 0) for (let k = 0; k < nor.itemSize; k++) n[i * nor.itemSize + k] = Math.min(top, -n[i * nor.itemSize + k]);
    index.needsUpdate = true; nor.needsUpdate = true;
  }
  const depthOnly = new THREE.MeshBasicMaterial({ colorWrite: false });
  function outline(mesh, edges) {
    faceOutward(mesh.geometry);
    const depth = new THREE.Mesh(mesh.geometry, depthOnly);
    depth.renderOrder = 4; depth.raycast = () => {}; mesh.add(depth);
    mesh.renderOrder = 5;
    if (edges) mesh.material.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>',
        `diffuseColor.a *= mix(0.35, 2.6, pow(1.0 - abs(dot(normalize(normal), normalize(vViewPosition))), 2.0));
         #include <opaque_fragment>`);
    };
    if (edges) mesh.material.customProgramCacheKey = () => 'outlined';
  }
  const ctxMats = Object.fromEntries(Object.entries(settings.context || {}).map(([kind, { order, rays, outlined, ...m }]) =>
    [kind, new THREE.MeshStandardMaterial(m.opacity == null ? m : { ...m, transparent: true, depthWrite: false })]));

  /* ---------------- model ---------------- */
  const bones = new Map();        // id -> record
  const ctxPieces = [];           // context meshes
  let pickables = [], blockers = [], liveMeshes = [], ctxLive = [], drawnLive = [];
  // what hides the piece being shown is faded so it is never buried (Study and Practice reveal): see updateOccluders
  const occ = { recs: new Set(), ctx: new Set(), key: '' };
  let modelBox = new THREE.Box3();

  function boneRecord(mesh, data) {
    own.wrap?.(mesh);
    mesh.geometry.computeBoundingSphere();
    const sphere = mesh.geometry.boundingSphere.clone().applyMatrix4(mesh.matrixWorld);
    // settings.pieceMaterial: where an atlas's pieces differ from the usual finish (doubleSided: thin sheets seen from both sides)
    const { doubleSided, ...finish } = settings.pieceMaterial || {};
    const p = PALETTE && PALETTE[data.mat];
    const mat = new THREE.MeshStandardMaterial({ color: pieceColor(data), roughness: p ? p.r : 0.45, metalness: p ? p.m : 0, envMapIntensity: p ? 1.0 : 0.9, ...finish, side: doubleSided ? THREE.DoubleSide : THREE.FrontSide });
    mesh.material = mat;
    let overlay = null;   // the highlight: a copy of the piece drawn over everything (not in a solid atlas, see SOLID)
    if (!SOLID) {
      overlay = new THREE.Mesh(mesh.geometry, overlayMat);
      overlay.visible = false; overlay.renderOrder = 10; overlay.raycast = () => {};
      mesh.add(overlay);
    }
    // anchor = the surface point nearest the piece's centre, so callout lines land on the piece (not in the middle of a curved sheet)
    const pos = mesh.geometry.attributes.position, v = new THREE.Vector3(), anchor = new THREE.Vector3();
    let best = Infinity; const step = Math.max(1, Math.floor(pos.count / 600));
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      const d = v.distanceToSquared(sphere.center); if (d < best) { best = d; anchor.copy(v); }
    }
    const rec = { id: data.id, data, mesh, mat, overlay, center: sphere.center, radius: sphere.radius, anchor, flash: null };
    mesh.userData.rec = rec;
    own.record?.(rec);
    return rec;
  }

  /* ---------------- items (what gets studied or quizzed) ---------------- */
  // Main: the groups marked main, either side counts. All: every unit (a piece, or one named branch), either side counts.
  function itemSource() {
    return state.set === 'all' ? Object.values(DATA.units) : Object.values(DATA.groups).filter(g => g.main);
  }
  function buildItems(sec = state.section) {
    const out = [];
    for (const g of itemSource()) {
      const acc = g.members.filter(id => inScope(BONE[id], sec));
      if (acc.length) out.push({ key: g.key, name: label(g), accept: new Set(acc) });
    }
    return out;
  }
  function countFor(sec) { return buildItems(sec).length; }
  function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
  // Hints on: what the piece does ("Radial artery (the wrist pulse)"). Hints off: the anatomical name.
  function label(o) { const [n, tech] = names(o); return state.hints ? n : tech; }
  function itemLabel(key) { return label(state.set === 'all' ? UNIT[key] : DATA.groups[key]); }
  function nameFor(rec) { return lowerFirst(state.set === 'names' ? label(DATA.groups[rec.data.group]) : label(rec.data)); }
  function itemFor(rec, items) { return items.find(it => it.accept.has(rec.id)); }

  /* ---------------- highlight (glow through other pieces) ---------------- */
  let glowing = [];   // the pieces being shown (each also carries r.glow = true)
  function setGlow(ids) {
    for (const r of glowing) { r.glow = false; if (r.overlay) r.overlay.visible = false; }
    glowing = [...ids].map(id => bones.get(id)).filter(Boolean);
    let unhid = false;
    for (const r of glowing) { r.glow = true; if (state.hidden.delete(r.id)) unhid = true; if (r.overlay) r.overlay.visible = true; }
    if (own.glow && own.glow(glowing)) unhid = true;   // (an atlas's own say: true = what is drawn has to be worked out again)
    if (unhid) applyVisibility();
    if (SOLID) paintAll();
  }
  // A solid atlas (settings.solid) shows things by colour alone: a piece's own colour, grey when it is outside the
  // chosen part (like the unlabelled parts of a textbook figure), its result after a round, and dark while another
  // piece is being shown (scaled to 0.2 in linear light: about half as bright on screen). The glow is added in tick.
  const WHITE = new THREE.Color(0xffffff);
  const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  // (a Name it question, settings.nameIt: the piece asked in its own colour, everything else dark grey, and no glow)
  function paint(r) {
    const c = r.mat.color.set(pieceColor(r.data));
    const asked = NAME && isolated();
    if (asked) { if (!asked.has(r.id)) c.setScalar((0.3 + 0.5 * lum(c)) * 0.28); return; }
    if (!inScope(r.data)) c.setScalar(0.3 + 0.5 * lum(c));
    if (r.tint) c.lerp(r.tint, 0.78);
    if (glowing.length && !r.glow) c.multiplyScalar(0.2);
  }
  function paintAll() { for (const r of bones.values()) paint(r); }
  function flash(rec, kind) { rec.flash = { color: kind === 'ok' ? COL.ok : COL.bad, t0: performance.now(), dur: kind === 'ok' ? 650 : 900 }; }

  /* callout: which item is labelled on the model right now, and which member it points at */
  const callout = { item: null, anchorId: null };
  function setCallout(item, anchorId) {
    callout.item = item; callout.anchorId = anchorId || null;
    $('callout').textContent = item ? item.name : '';
  }

  /* ---------------- study mode ---------------- */
  let study = null;
  function startStudy() {
    study = { items: buildItems(), index: 0 };
    // (settings.studyOpensHome: with a part of the map chosen, the camera goes to the first piece's own view, not the part's)
    showStudyItem(settings.studyOpensHome === true && state.section !== 'all');
  }
  function showStudyItem(moveCamera = true, anchorId = null) {
    if (study) { study.peek = null; study.cleared = false; }
    if (!study || !study.items.length) { setGlow([]); setCallout(null); renderPrompt(); return; }
    const it = study.items[study.index];
    own.stop?.();
    ensureInView(it.accept);
    if (moveCamera) own.expose?.(it.accept);
    setGlow(it.accept);
    setCallout(it, anchorId);
    if (moveCamera) showBones([...it.accept].map(id => bones.get(id)).filter(Boolean));
    renderPrompt();
  }
  function studyStep(d) {
    if (state.mode !== 'study' || !study || !study.items.length) return;
    // after Esc, the first arrow brings the current piece back (settings.deselectKeepsPlace: the arrows move on from it)
    if (study.cleared) { study.cleared = false; if (d > 0 && !settings.deselectKeepsPlace) d = 0; }
    study.index = (study.index + d + study.items.length) % study.items.length;
    showStudyItem(true);
  }
  // Esc in Study: no piece is highlighted and the prompt shows the area only; the arrows pick up where you were.
  // (settings.deselectKeepsPlace: the prompt keeps its place in the list instead, and says to click a part)
  function clearStudySelection() {
    if (!study) return;
    study.peek = null; study.cleared = true;
    setGlow([]); setCallout(null); renderPrompt();
  }

  /* ---------------- quiz session (practice / test) ---------------- */
  let session = null, sessionSeq = 0, review = null;
  function startSession(onlyKeys) {
    if (NAME && session) { session = null; occ.key = ''; applyVisibility(); if (SOLID) { paintAll(); showThrough(null); } }   // (a piece shown on its own: everything is drawn again)
    clearQuizVisuals();
    clearReview();
    if (state.mode === 'study') { session = null; startStudy(); renderStats(); return; }
    study = null;
    own.stop?.();
    let items = buildItems();
    if (onlyKeys) items = items.filter(it => onlyKeys.includes(it.key));
    shuffle(items);
    if (state.mode === 'practice') {
      const hist = store.get('stats', {});
      const weak = (it) => { const h = hist[it.key]; return h ? h[1] - h[0] * 0.5 : 0; };
      items = items.map((it, i) => [it, weak(it), i]).sort((a, b) => (b[1] - a[1]) || (a[2] - b[2])).map(x => x[0]);
    }
    session = {
      id: ++sessionSeq, busy: false, items, queue: items.slice(), total: items.length, done: 0, attempts: 0, correct: 0,
      streak: 0, start: performance.now(), end: null, current: null, phase: 'ask', everMissed: new Set(),
    };
    renderStats();
    nextItem();
  }
  function clearQuizVisuals() { setGlow([]); setCallout(null); }
  function later(ms) {
    const id = session && session.id;
    setTimeout(() => { if (session && session.id === id) nextItem(); }, ms);
  }
  function nextItem() {
    if (!session) return;
    clearQuizVisuals();
    own.between?.();   // (between questions: an atlas undoes what it opened to show the last answer)
    session.busy = false;
    if (!session.queue.length) return finishSession();
    session.current = session.queue.shift();
    session.phase = 'ask';
    own.ask?.(session.current.accept);   // (...and makes sure the next one can be seen and clicked)
    own.expose?.(session.current.accept, true);
    if (naming()) askName();
    renderPrompt();
    // the cursor goes to the answer box (not on a phone: its keyboard comes up when the box is tapped, and then stays up
    // from one question to the next)
    if (isolated() && !narrow()) $('answerBox').focus({ preventScroll: true });
  }
  function recordStat(key, ok) {
    const hist = store.get('stats', {});
    const h = hist[key] || [0, 0]; h[ok ? 0 : 1]++; hist[key] = h; store.set('stats', hist);
  }
  function answer(rec) {
    if (!session || !session.current || session.busy || naming()) return;
    const cur = session.current, hit = cur.accept.has(rec.id);
    if (session.phase === 'reveal') {
      if (hit) { flash(rec, 'ok'); clearQuizVisuals(); session.busy = true; later(350); }
      else { flash(rec, 'bad'); toast(t('thats_the_reveal', { name: nameFor(rec) }), 'bad'); }
      return;
    }
    session.attempts++;
    if (hit) {
      session.correct++; session.streak++; session.done++;
      recordStat(cur.key, true);
      flash(rec, 'ok'); pulsePrompt('ok');
      renderStats(); renderPrompt();
      session.busy = true;
      later(state.mode === 'test' ? 260 : 420);
    } else {
      session.streak = 0;
      recordStat(cur.key, false);
      flash(rec, 'bad'); pulsePrompt('bad');
      toast(t('thats_the', { name: nameFor(rec) }), 'bad');
      miss(cur, rec);
    }
    renderStats();
  }
  function miss(cur, clickedRec) {
    session.everMissed.add(cur.key);
    if (state.mode === 'test') { session.busy = true; later(clickedRec ? 650 : 200); return; }
    // Practice: show where it is, make them click it, and bring it back a few questions later.
    session.queue.splice(Math.min(3, session.queue.length), 0, cur);
    session.phase = 'reveal';
    const members = [...cur.accept].map(id => bones.get(id)).filter(Boolean);
    let near = members[0];
    if (clickedRec && members.length > 1) near = members.reduce((b, r) => r.center.distanceTo(clickedRec.center) < b.center.distanceTo(clickedRec.center) ? r : b, members[0]);
    ensureInView(cur.accept);
    own.expose?.(cur.accept, true);
    setGlow(cur.accept);
    setCallout(cur, near && near.id);
    showBones(members, near);
    renderPrompt();
  }
  function skip() {
    if (state.mode === 'study' || !session || !session.current || session.busy) return;
    if (naming()) { helpName(); return; }
    if (session.phase === 'reveal') { clearQuizVisuals(); nextItem(); return; }
    session.attempts++; session.streak = 0;
    recordStat(session.current.key, false);
    miss(session.current, null);
    renderStats();
  }
  function finishSession() {
    session.end = performance.now();
    session.current = null;
    if (NAME) { occ.key = ''; applyVisibility(); if (SOLID) { paintAll(); showThrough(null); } }
    const ms = session.end - session.start;
    const firstTry = session.total - session.everMissed.size;
    const acc = session.attempts ? Math.round(100 * session.correct / session.attempts) : 0;
    const k = bestKey();
    const bestAll = store.get('best', {});
    const prev = bestAll[k];
    const scoreNow = state.mode === 'test' ? session.correct : firstTry;
    if (!prev || scoreNow > prev.score || (scoreNow === prev.score && ms < prev.ms)) {
      bestAll[k] = { score: scoreNow, total: session.total, ms }; store.set('best', bestAll);
    }
    const best = bestAll[k];
    // Colour every piece in the selection by how it went: right first time vs missed (or needed help in Practice).
    const status = new Map();
    for (const it of session.items) {
      const ok = !session.everMissed.has(it.key);
      for (const id of it.accept) status.set(id, ok ? 'ok' : 'bad');
    }
    const missedItems = session.items.filter(it => session.everMissed.has(it.key));
    review = { status, ok: scoreNow, bad: session.total - scoreNow, acc, ms, best, missedKeys: missedItems.map(it => it.key) };
    applyReviewColors();
    $('rOk').textContent = review.ok; $('rBad').textContent = review.bad;
    renderReviewLabels();
    $('rPractice').hidden = !missedItems.length;
    renderPrompt(); renderStats(); renderBest();
    $('sTime').textContent = fmtTime(ms);
    frameSection(settings.reviewKeepsAngle ? camera.position.clone().sub(controls.target) : undefined);   // pull back; reviewKeepsAngle: without turning
  }
  function clearReview() {
    if (!review) return;
    review = null;
    for (const r of bones.values()) { r.mat.color.set(pieceColor(r.data)); r.tint = null; }
    if (SOLID) paintAll();
    $('review').hidden = true; $('pBarWrap').hidden = false; $('skipBtn').hidden = state.mode === 'study' || naming();
    setCallout(null);
  }
  const TINT = { ok: new THREE.Color(0x46c98a), bad: new THREE.Color(MISS.review) };   // matches --ok / --miss in the stylesheet
  function applyReviewColors() {
    for (const r of bones.values()) {
      const st = review && review.status.get(r.id);
      r.tint = st ? TINT[st] : null;
      if (st) r.mat.color.set(pieceColor(r.data)).lerp(TINT[st], 0.78); else r.mat.color.set(pieceColor(r.data));
    }
    if (SOLID) paintAll();
  }
  // Test counts correct / missed; Practice counts right first time / needed help.
  function renderReviewLabels() {
    const test = state.mode === 'test';
    $('rOkLabel').textContent = t(test ? 'r_correct' : 'r_first', { n: review.ok });   // "1 raté" / "2 ratés"
    $('rBadLabel').textContent = t(test ? 'r_missed' : 'r_help', { n: review.bad });
  }
  function reviewPick(rec) {
    const st = review.status.get(rec.id);
    if (!st) return;
    const test = state.mode === 'test';
    const verdict = t(st === 'ok' ? (test ? 'rp_correct' : 'rp_first') : (test ? 'rp_missed' : 'rp_help'));
    // the name of what was asked: the piece, or in the Main set its group (settings.reviewNamesPiece: always the piece)
    const name = label(state.set === 'all' || settings.reviewNamesPiece ? rec.data : DATA.groups[rec.data.group]);
    setCallout({ name: t('name_verdict', { name, verdict }), accept: new Set([rec.id]) }, rec.id);
  }
  $('rAgain').addEventListener('click', () => startSession());
  $('rPractice').addEventListener('click', () => {
    const keys = review ? review.missedKeys.slice() : [];
    setMode('practice', false); startSession(keys);
  });
  // '|both' is left over from when a quiz could cover one side only; keeping it keeps earlier best scores.
  // (Name it keeps its own best scores: '|name')
  function bestKey() { return `${state.mode}|${state.set}|${state.section}|${settings.bodies ? state.sex : 'both'}` + (state.hints ? '' : '|nohints') + (naming() ? '|name' : ''); }

  /* ---------------- Name it (settings.nameIt): one piece shown on its own, and its name typed ---------------- */
  // The piece being asked is drawn whole and still, with the frame (the skeleton) around it and everything else faint
  // (applyVisibility), from its standard view; nothing glows, nothing fades for being in front, and nothing is clicked:
  // where the frame hides the piece it shows through, fainter. What counts as its name, and the
  // hints, are answers.js. Practice: each hint gives a little more (the name's length, its first letter, then the
  // name, to be typed out), a wrong answer empties the box and gives the next hint, and a piece that needed any of it
  // comes back a few questions later; it is learned once it is typed with no help. Test: one answer each, no hints.
  // In English the answer line shows a name with a capital on every word ("Temporal Bone"); what is typed needs none.
  const shownName = (name) => lang.code === 'en' ? titleCase(name) : name;
  function isolated() { return naming() && session && session.current ? session.current.accept : null; }
  // everything in the atlas that has a name, in the language in use and in English (both count): an answer is weighed
  // against all of them. settings.nameIt.sides: the words for a side, in every language, where a name without its side
  // counts (Bone Atlas: "femur" for the right femur)
  let everyName = null;
  function askName() {
    const cur = session.current;
    const o = state.set === 'all' ? UNIT[cur.key] : DATA.groups[cur.key];
    if (!everyName) everyName = [...Object.values(DATA.groups), ...Object.values(UNIT)].map(x => ({ o: x, names: [names(x), [x.name, x.tech || x.name]], members: x.members }));
    session.name = { level: 0, helped: false, verdict: null, answer: shownName(names(o)[1]), counts: answersFor(everyName.find(x => x.o === o), everyName, { fold, sides: NAME.sides || [], filler: NAME.filler || [] }) };
    for (const id of cur.accept) state.hidden.delete(id);
    if (zoomed() && [...cur.accept].some(id => BONE[id] && !inView(BONE[id]))) setView('all', 'both', false);
    let shown = [...cur.accept].map(id => bones.get(id)).filter(Boolean);
    // settings.nameIt.whole (Bone Landmarks: 'bone' = what the data calls the thing a piece is part of): the piece is
    // asked on that one thing, drawn solid, pieces and frame alike, with everything else as faint as `rest`: a landmark on
    // its own bone, as a lab practical hands it over. With the whole skeleton solid the skull stood between the camera
    // and the atlas, and the three typical vertebrae stood in a row. Where the name is on several (a left and a right
    // bone, a pedicle on each kind of vertebra), it is the one nearest to where the camera is looking.
    if (NAME.whole && !SOLID && shown.length) {
      const f = shown.reduce((b, r) => r.center.distanceTo(controls.target) < b.center.distanceTo(controls.target) ? r : b);
      shown = shown.filter(r => r.data[NAME.whole] === f.data[NAME.whole] && r.data.side === f.data.side);
      session.name.on = { whole: f.data[NAME.whole], side: f.data.side || '', pieces: new Set(shown.map(r => r.id)) };
      session.name.on.radius = shownOn().radius;
    }
    // (a solid atlas shows it with its usual steady highlight, the part's own colour lifted, with no pulse: a groove of the
    // Brain Atlas is drawn toward the viewer only while it is highlighted)
    if (SOLID) { setGlow(cur.accept); paintAll(); showThrough(cur.accept); }
    frameNamed(shown);   // (which also says which side of the body the view is for, and whether only that side is drawn)
    if (!SOLID) {
      applyVisibility();
      if (NAME.infront != null) { session.name.front = standingInFront(shown); if (session.name.front.size) applyVisibility(); }
    }
    $('answerBox').value = '';
  }
  // A solid atlas has no highlight copies (r.overlay), so the asked piece gets its own copy drawn over everything,
  // fainter, for where other parts cover it (the Brain Atlas's pyramids lie in the surface of the medulla). Only a small
  // piece: a big one (a lobe) is seen anyway, and its copy would show its own folds through it.
  let throughShown = [];
  function showThrough(ids) {
    for (const m of throughShown) m.visible = false;
    throughShown = [];
    if (!ids || NAME.through === 0) return;
    const whole = modelBox.getBoundingSphere(new THREE.Sphere()).radius;
    for (const id of ids) {
      const r = bones.get(id); if (!r || r.radius > whole * 0.2) continue;
      if (!r.through) { r.through = new THREE.Mesh(r.mesh.geometry, throughMat(r)); r.through.renderOrder = 10; r.through.raycast = () => {}; r.mesh.add(r.through); }
      r.through.visible = true; throughShown.push(r.through);
    }
  }
  // The camera goes to the piece's standard view (its area, from the side it is best seen from), but closer: the piece
  // with room around it (settings.nameIt.room), and never less than 0.6 of its area (settings.nameIt.near), enough to
  // tell where on the body it is.
  // A zoom area picked by hand is kept, as everywhere.
  // settings.nameIt.infront: the pieces of the frame that stand between the camera and the asked piece, seen from where
  // the camera is going (the end of the flight frameNamed just started). Lines of sight go to points spread through the
  // piece; a point on its far side, hidden by the piece itself, says nothing. Only if more than a quarter of the rest
  // are blocked (settings.nameIt.hidden) does anything count as in front, and then everything that blocks one. It is
  // worked out once a question and left alone while the model is turned, like the fading in Study.
  // Of a left and right pair only the one the view is for: seen from the side, the other is behind the whole body, and
  // nothing should fade for that (where both sides are drawn: the head and the trunk).
  const eyeSph = new THREE.Spherical();
  function standingInFront(members) {
    const front = new Set();
    if (!members.length) return front;
    const eye = fly ? new THREE.Vector3().setFromSpherical(eyeSph.set(fly.r1, fly.ph1, fly.th0 + fly.dth).makeSafe()).add(fly.t1) : camera.position.clone();
    const look = (fly ? fly.t1 : controls.target).clone().sub(eye).normalize();
    const side = session.name.side || 'both';
    members = members.filter(r => inSide(r.data, side));
    if (!members.length) return front;
    const near = members.reduce((b, r) => r.center.distanceTo(eye) < b.center.distanceTo(eye) ? r : b);
    const off = new THREE.Vector3();
    const facing = members.filter(r => {   // (not the ones more behind the nearest than beside it)
      const depth = off.copy(r.center).sub(near.center).dot(look);
      return r === near || depth <= Math.sqrt(Math.max(0, off.lengthSq() - depth * depth));
    }).slice(0, 24);
    const asked = new Set(facing.map(r => r.mesh));
    const targets = ctxPieces.filter(c => c.mesh.visible && c.mesh.material.opacity > NAME.infront).map(c => c.mesh).concat([...asked]);
    // (about 120 lines of sight, each tried against every bone: with half as many, a bone in front was often missed)
    const per = Math.max(5, Math.min(48, Math.floor(120 / facing.length)));
    const blocks = new Map(), point = new THREE.Vector3(), dir = new THREE.Vector3();
    let open = 0, blocked = 0;
    for (const r of facing) {
      const pos = r.mesh.geometry.attributes.position, n = Math.min(per, pos.count);
      for (let i = 0; i < n; i++) {
        point.fromBufferAttribute(pos, Math.floor((i + 0.5) * pos.count / n)).applyMatrix4(r.mesh.matrixWorld);
        dir.copy(point).sub(eye); const dist = dir.length();
        raycaster.set(eye, dir.normalize()); raycaster.near = 0; raycaster.far = Math.max(0, dist - 0.002);
        const hits = raycaster.intersectObjects(targets, false);
        if (hits.some(h => asked.has(h.object))) continue;
        open++;
        if (hits.length) blocked++;
        for (const m of new Set(hits.map(h => h.object))) blocks.set(m, (blocks.get(m) || 0) + 1);
      }
    }
    raycaster.far = Infinity;
    if (open && blocked / open > (NAME.hidden ?? 0.25)) for (const m of blocks.keys()) front.add(m);
    return front;
  }
  // (settings.nameIt.whole: the area is the thing the piece is shown on, its bone, whatever the zoom areas are)
  function shownOn() {
    const on = session.name && session.name.on; if (!on) return null;
    const box = new THREE.Box3(), is = (d) => !!d && d[NAME.whole] === on.whole && (d.side || '') === on.side;
    const add = (mesh) => { if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox(); box.union(mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld)); };
    for (const r of bones.values()) if (is(r.data)) add(r.mesh);
    for (const c of ctxPieces) if (is(DATA.context[c.id])) add(c.mesh);
    return box.getBoundingSphere(new THREE.Sphere());
  }
  function frameNamed(members) {
    if (!members.length) return;
    if (own.showBones) return own.showBones(members);
    if (zoomed()) { if (!onScreen(members)) frameSection(); return; }
    const v = standardView(members);
    // The side of the body the view is for (an area framed one side at a time: a limb). Looked at from the midline side,
    // only that side is drawn: the inner side of a foot is seen from beyond the other foot, which would stand in the way.
    session.name.side = v.side;
    session.name.only = v.side !== 'both' && /^medial/.test(v.turn || '') ? v.side : 'both';
    const box = new THREE.Box3();
    for (const r of members) {
      if (v.side !== 'both' && sideOf(r) && sideOf(r) !== v.side) continue;   // (an area framed one side at a time)
      if (!r.mesh.geometry.boundingBox) r.mesh.geometry.computeBoundingBox();
      box.union(r.mesh.geometry.boundingBox.clone().applyMatrix4(r.mesh.matrixWorld));
    }
    const on = shownOn(), piece = box.getBoundingSphere(new THREE.Sphere()), area = on || scopeSphere(v.key, v.side);
    // (the room shrinks for a long piece, such as a ligament the length of the spine: 1.1 times its size from a third
    // of the whole model up, or the camera would be back at the whole body)
    const whole = modelBox.getBoundingSphere(new THREE.Sphere()).radius, big = Math.min(1, Math.max(0, (piece.radius / whole - 0.06) / 0.27));
    const room = (NAME.room || 1.8) * (1 - big) + 1.1 * big;
    // (settings.nameIt.far: ...and a small piece is never less than 1/far of the picture, however big its area)
    // (near can be a function of the asked piece's data: the Heart Atlas shows the whole heart round a valve)
    const near = typeof NAME.near === 'function' ? NAME.near(members[0].data) : NAME.near ?? 0.6;
    // (a piece that reaches out of its area, the forearm's membrane from the elbow down, is framed for itself)
    const inside = piece.center.distanceTo(area.center) + piece.radius <= area.radius * 1.15;
    const radius = Math.max(piece.radius * room, Math.min(area.radius * near, piece.radius * (NAME.far || Infinity)));
    const center = (radius < area.radius || !inside ? piece : area).center.clone();
    // (shown on its bone: the camera leans toward the middle of the bone, to show more of it, as far as the piece stays
    // well inside the picture)
    if (on && radius < area.radius) {
      const to = area.center.clone().sub(center), d = to.length();
      if (d > 0) center.add(to.multiplyScalar(Math.min(d, Math.max(0, Math.min(radius - piece.radius * 1.5, radius * 0.55))) / d));
    }
    flyTo(center, fitDistance(Math.max(inside ? Math.min(radius, area.radius) : piece.radius * room, 0.02)), v.turn ? VIEW_DIRS[v.turn] : zoomDir(v.key, v.side));
    autoView = '';
  }
  function submitName() {
    const q = session && session.name;
    if (!isolated() || session.busy || !q) return;
    const cur = session.current, test = state.mode === 'test', box = $('answerBox');
    const res = judge(box.value, q.counts, { fold, filler: NAME.filler });
    if (res.empty) { if (!test) helpName(); return; }   // Enter with nothing typed: a hint
    if (res.vague) { toast(t('name_vague', { text: box.value.trim() })); box.select(); return; }   // "quads": which of the four? Not held against them
    const members = [...cur.accept].map(id => bones.get(id)).filter(Boolean);
    if (res.ok) {
      if (!q.helped) { session.attempts++; session.correct++; session.streak++; session.done++; recordStat(cur.key, true); }
      q.verdict = res.exact ? 'right' : 'close';   // close: a near miss in the spelling, shown spelled right for a little longer
      members.forEach(r => flash(r, 'ok')); pulsePrompt('ok');
      session.busy = true;
      later(res.exact ? (test ? 300 : 500) : (test ? 1100 : 1500));
    } else if (test) {
      session.attempts++; session.streak = 0; recordStat(cur.key, false); session.everMissed.add(cur.key);
      q.verdict = 'wrong';
      members.forEach(r => flash(r, 'bad')); pulsePrompt('bad');
      session.busy = true;
      later(1300);
    } else {
      // a wrong answer: the box is emptied (left in, it sat on top of the hint), what was typed is said underneath
      // until the next key, and the next hint is given
      pulsePrompt('bad');
      q.wrong = box.value.trim(); box.value = '';
      if (q.level < HINTS) helpName(); else renderPrompt();
      return;
    }
    box.value = shownName(cur.name);
    renderStats(); renderPrompt();
  }
  // Practice: the next hint; once the name itself is showing, on to the next piece. Test: skip this one.
  function helpName() {
    const q = session.name, cur = session.current;
    if (q.verdict) return;
    if (state.mode === 'test') {
      session.attempts++; session.streak = 0; recordStat(cur.key, false); session.everMissed.add(cur.key);
      q.verdict = 'wrong'; $('answerBox').value = shownName(cur.name);
      session.busy = true; later(1300);
      renderStats(); renderPrompt();
      return;
    }
    if (q.level >= HINTS) { nextItem(); return; }
    if (!q.helped) {   // needing help counts once, as a miss, and brings the piece back later
      q.helped = true;
      session.attempts++; session.streak = 0; recordStat(cur.key, false); session.everMissed.add(cur.key);
      session.queue.splice(Math.min(3, session.queue.length), 0, cur);
      renderStats();
    }
    q.level++;
    renderPrompt();
  }
  // The answer line: the box, and behind it one place per letter once a hint has said how long the name is, with the
  // letters the hint gives away shown until they are typed over.
  function renderAnswer() {
    const q = session.name, typed = [...$('answerBox').value].length;
    const slots = q.level && !q.verdict ? hintSlots(q.answer, q.level) : [];
    $('answerSlots').replaceChildren(...slots.map((s, i) => {
      const el = document.createElement('i');
      if (s.blank) el.className = 'blank';
      if (s.shown && i >= typed) el.textContent = s.ch;
      return el;
    }));
    const line = $('answerLine');
    line.classList.toggle('has-slots', slots.length > 0);
    line.classList.toggle('is-empty', !slots.length && !typed && !q.verdict);
    line.style.setProperty('--n', Math.max(slots.length, typed + 1));
    $('answerHelp').textContent = t(state.mode === 'test' || q.level >= HINTS ? 'skip' : 'clue');
    $('answerHelp').hidden = !!q.verdict;
    fitAnswer();
  }
  // A name too long for the tag is scaled down to fit (scaled, not set smaller: a phone zooms the page in on a box
  // whose text is under 16px)
  function fitAnswer() {
    const form = $('answer');
    if (!form || form.hidden) return;
    const line = $('answerLine');
    line.style.transform = '';
    const avail = form.clientWidth, w = line.offsetWidth;
    if (avail && w > avail) line.style.transform = `scale(${(avail / w).toFixed(3)})`;
  }
  if (NAME) {
    $('answer').addEventListener('submit', (e) => { e.preventDefault(); submitName(); });
    $('answerBox').addEventListener('beforeinput', (e) => { if (session && session.busy) e.preventDefault(); });   // (the answer is on show)
    $('answerBox').addEventListener('input', () => {
      if (!isolated() || !session.name) return;
      if (session.name.wrong) { session.name.wrong = ''; renderPrompt(); } else renderAnswer();
    });
    $('answerHelp').addEventListener('pointerdown', (e) => e.preventDefault());   // the box keeps the cursor (and a phone its keyboard)
    $('answerHelp').addEventListener('click', () => { skip(); if (isolated()) $('answerBox').focus({ preventScroll: true }); });
    $('quizSeg').addEventListener('click', (e) => {
      const v = e.target.closest('button')?.dataset.v; if (!v || v === state.quiz) return;
      guardTest(t('what_mode', { mode: t('quiz_' + v) }), () => { state.quiz = v; store.set('quiz', v); renderSegs(); renderBest(); startSession(); });
    });
  }

  /* ---------------- visibility (region, side, x-ray, peel) ---------------- */
  // (a Name it piece seen through the frame: its highlight copy, in its own colour and lit like it, drawn over everything)
  let seenThrough = [];
  const throughMats = new Map();
  const namedColor = (r) => NAME.color ?? pieceColor(r.data);
  let recoloured = [];
  function throughMat(r) {
    const c = namedColor(r);
    if (!throughMats.has(c)) throughMats.set(c, new THREE.MeshStandardMaterial({ color: c, roughness: r.mat.roughness, metalness: r.mat.metalness, envMapIntensity: r.mat.envMapIntensity, transparent: true, opacity: NAME.through ?? 0.4, depthTest: false, depthWrite: false }));
    return throughMats.get(c);
  }
  function applyVisibility() {
    pickables = []; blockers = []; liveMeshes = []; ctxLive = []; drawnLive = [];
    // Name it: the piece being asked is drawn whole, the rest faintly or not at all, whatever the view, layer or X-ray
    // (settings.nameIt.whole: only the one of them that is shown, on what it is part of; see askName)
    const on = !SOLID && isolated() && session.name ? session.name.on : null;
    const alone = SOLID ? null : on ? on.pieces : isolated();
    const ofWhole = (d) => !!on && !!d && d[NAME.whole] === on.whole && (d.side || '') === on.side;
    // (settings.nameIt.infront, around: the frame in front of the piece, and outside its own part of the map)
    // (settings.nameIt.without(id, its data, the asked piece's data): a piece of the frame left out for that piece)
    const front = alone && session.name && session.name.front, first = alone ? BONE[[...alone][0]] : null;
    const itsPart = first && NAME.around != null ? first.region + (first.sub ? '/' + first.sub : '') : null;
    // (the one side of the body that is drawn, where the view is from the midline side: frameNamed)
    const side = alone && !on && session.name && session.name.only || 'both';
    for (const r of seenThrough) { r.overlay.material = overlayMat; r.overlay.visible = !!r.glow; }
    seenThrough = [];
    for (const r of recoloured) r.mat.color.set(pieceColor(r.data));   // (settings.nameIt.color: each piece back in its own)
    recoloured = [];
    for (const r of bones.values()) {
      if (alone) {
        // (settings.nameIt.beside(a piece's data, the asked piece's data): how strongly that piece is drawn beside this
        // one, where it is more than `rest`: the rest of the heart round a chamber or a valve)
        const it = alone.has(r.id) && inSide(r.data, side);
        const opacity = it || ofWhole(r.data) ? 1 : Math.max(NAME.rest || 0, NAME.beside && first ? NAME.beside(r.data, first) || 0 : 0), solid = opacity >= 1;
        r.mesh.visible = it || (opacity > 0 && inBody(r.data));
        if (r.mat.transparent !== !solid) { r.mat.transparent = !solid; r.mat.needsUpdate = true; }
        r.mat.opacity = opacity; r.mat.depthWrite = solid;
        if (r.pick) r.pick.visible = false;
        if (it) {
          liveMeshes.push(r.mesh);
          if (NAME.color != null) { r.mat.color.set(NAME.color); recoloured.push(r); }
          // ...and where the frame stands in front of it, it shows through, fainter (settings.nameIt.through: how
          // strongly; 0 = not at all): a muscle under the ribs is still there to be named, and no bone has to go
          // (shown on its bone, only a small piece, a canal or a facet: a big one is seen anyway, and through its own bone it is a muddle)
          if (r.overlay && NAME.through !== 0 && !(on && r.radius > on.radius * 0.3)) { r.overlay.material = throughMat(r); r.overlay.visible = true; seenThrough.push(r); }
        }
        continue;
      }
      const inQuiz = inScope(r.data), live = inQuiz && inView(r.data);
      // hidden by peel mode or peeled away by the Layers control
      // hidden: by hand, by the Layers control, by belonging to the other body, or (settings.hideOutsideSection, Organ: its
      // systems overlap too much to leave faint copies around) by being outside the chosen part
      // (settings.layersHide: false = the data's `layer` means something else there: how far the Engine must be open)
      // an atlas's own say: { hidden, ghost: an opacity it is capped at, stillLive, shown: drawn even outside the zoom area (solid) }
      const how = own.piece ? own.piece(r) : null;
      const hidden = state.hidden.has(r.id) || (settings.layersHide !== false && r.data.layer < state.layer) || !inBody(r.data) || (settings.hideOutsideSection === true && !inQuiz) || !!(how && how.hidden);
      if (SOLID) {   // drawn whole or not at all; a piece outside the chosen part stays, and can be clicked
        const there = !hidden && (inView(r.data) || !!(how && how.shown));
        r.mesh.visible = there;
        const transparent = state.xray;
        if (r.mat.transparent !== transparent) { r.mat.transparent = transparent; r.mat.needsUpdate = true; }
        r.mat.opacity = state.xray ? DIM.xray : 1; r.mat.depthWrite = !transparent;
        if (there) { liveMeshes.push(r.mesh); pickables.push(r.mesh); drawnLive.push(r.mesh); }
        continue;
      }
      const occluding = occ.recs.has(r);
      r.mesh.visible = !hidden;
      let opacity = !live ? (inQuiz ? DIM.outOfView : DIM.away) : occluding ? DIM.inFront : (state.xray ? DIM.xray : 1);
      const ghost = !!how && how.ghost != null;
      if (ghost) opacity = Math.min(opacity, how.ghost);
      if (how) r.mesh.renderOrder = ghost ? -1 : 0;
      const transparent = opacity < 1;
      if (r.mat.transparent !== transparent) { r.mat.transparent = transparent; r.mat.needsUpdate = true; }
      r.mat.opacity = opacity; r.mat.depthWrite = !transparent;
      if (r.pick) r.pick.visible = false;
      if (live && !ghost && (!hidden || (how && how.stillLive))) { liveMeshes.push(r.mesh); if (!occluding) { pickables.push(r.pick || r.mesh); drawnLive.push(r.mesh); } }   // clicks land on the fatter pick tube
    }
    for (const c of ctxPieces) {
      // the Bones button hides the frame (the skeleton, brain, organs), except the kinds in settings.frameAlwaysShown (tendons).
      // An atlas with its own rule gives it as settings.frameShown (Organ: which landmarks show with which system).
      c.mesh.visible = settings.frameShown
        ? settings.frameShown(c, { bones: state.bones, region: parseSection(state.section).region })
        : state.bones || (settings.frameAlwaysShown || []).includes(c.kind);
      if (!c.mesh.visible) continue;
      const live = !!alone || settings.frameAlwaysLive || (inSection(c) && inView(c));   // frameAlwaysLive: the frame never fades with the view
      const op = !live ? Math.min(FADE.away, c.baseOpacity) : occ.ctx.has(c.mesh) ? Math.min(FADE.inFront, c.baseOpacity)
        : alone ? Math.min(c.baseOpacity, on ? (ofWhole(DATA.context[c.id]) ? 1 : NAME.rest || 0) : (NAME.faint || {})[c.kind] ?? 1,
          itsPart && !inSection(c, itsPart) ? NAME.around : 1, front && front.has(c.mesh) ? NAME.infront : 1, inSide(c, side) ? 1 : FADE.away,
          first && NAME.without && NAME.without(c.id, DATA.context[c.id], first) ? 0 : 1)
        : (state.xray ? Math.min(c.baseOpacity, FADE.xray) : c.baseOpacity);
      if (alone && !op) { c.mesh.visible = false; continue; }
      const transparent = op < 1;
      if (c.mesh.material.transparent !== transparent) { c.mesh.material.transparent = transparent; c.mesh.material.needsUpdate = true; }
      c.mesh.material.opacity = op; c.mesh.material.depthWrite = !transparent;
      if (live) { liveMeshes.push(c.mesh); if (!occ.ctx.has(c.mesh) && CONTEXT_CLICKABLE[c.kind]) blockers.push(c.mesh); ctxLive.push(c.mesh); }
    }
    own.visibility?.();
    $('unhideBtn').hidden = state.hidden.size === 0;   // only there when something is hidden
    $('unhideBtn').textContent = t('show_hidden', { n: state.hidden.size });
  }

  /* ---------------- picking ---------------- */
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  // Thin pieces are hard to hit, so a click is forgiving: the ray under the cursor is tried first (against the fatter pick tubes),
  // then rays on rings 6 px and 12 px out, and the nearest piece hit wins. Only when no piece is near does the context
  // piece under the cursor (a bone, the brain) get named.
  // How far a piece of the frame fades (settings.frameFade changes any of these): away = it isn't part of what is being
  // looked at, inFront = it is between the camera and the piece being shown, xray = X-ray is on.
  const FADE = { away: 0.04, inFront: 0.1, xray: 0.12, ...settings.frameFade };
  // The same for the atlas's own pieces (settings.pieceFade): away = outside the chosen part, outOfView = in it but not in
  // the area being looked at, inFront = between the camera and the piece being shown (dark pieces need more), xray.
  const DIM = { away: 0.07, outOfView: 0.03, inFront: 0.1, xray: 0.32, ...settings.pieceFade };
  const PICK_RING = [[6, 0], [-6, 0], [0, 6], [0, -6], [4.2, 4.2], [-4.2, 4.2], [4.2, -4.2], [-4.2, -4.2],
                     [12, 0], [-12, 0], [0, 12], [0, -12], [8.5, 8.5], [-8.5, 8.5], [8.5, -8.5], [-8.5, -8.5]];
  function castAt(clientX, clientY, targets) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    return raycaster.intersectObjects(targets, false);
  }
  // settings.clicks = 'exact' (the atlases with a solid skeleton): a click counts only where it lands, and the solid
  // parts of the frame block it. In X-ray the smallest piece under the cursor wins, so inner ones can be reached.
  function pickExactly(clientX, clientY) {
    if (state.xray) {
      const hits = castAt(clientX, clientY, pickables);
      if (!hits.length) return null;
      let best = null;
      for (const h of hits) { const rec = h.object.userData.rec; if (!best || rec.radius < best.radius) best = rec; }
      return { rec: best };
    }
    const hits = castAt(clientX, clientY, pickables.concat(blockers));
    if (!hits.length) return null;
    const o = (own.pickFrom && own.pickFrom(hits)) || hits[0].object;   // (an atlas's own choice among what is under the cursor)
    return o.userData.rec ? { rec: o.userData.rec } : { ctx: o.userData.ctx };
  }
  function pickAt(clientX, clientY) {
    if (settings.clicks === 'exact') return pickExactly(clientX, clientY);
    const targets = pickables.concat(blockers);
    let hits = castAt(clientX, clientY, targets);
    if (state.xray) {
      if (!hits.length) for (const [dx, dy] of PICK_RING) { hits = castAt(clientX + dx, clientY + dy, pickables); if (hits.length) break; }
      if (!hits.length) return null;
      // in x-ray the smallest piece under the cursor wins, so inner ones can be reached
      let best = null;
      for (const h of hits) { const rec = h.object.userData.rec; if (rec && (!best || rec.radius < best.radius)) best = rec; }
      return best ? { rec: best } : null;
    }
    let o = hits.length ? hits[0].object : null;
    if (o && o.userData.rec) {
      // the fat tube of a big piece can wrap a thin one that is visibly under the cursor: a piece whose drawn surface
      // is hit within 6 mm of the first hit wins over a pick tube
      const dh = castAt(clientX, clientY, drawnLive);
      if (dh.length && dh[0].distance <= hits[0].distance + (settings.clickDepth || 0.006)) o = dh[0].object;   // (settings.clickDepth: that margin)
      // a lump on a tube (a ganglion on the sympathetic trunk, a root at the brainstem) wins over the tube it sits on
      const lump = settings.clickLumps === false ? null : dh.find(h => !h.object.userData.rec.pick && h.distance <= dh[0].distance + 0.008);
      if (lump) o = lump.object;
    }
    if (!o || !o.userData.rec) {
      for (const [dx, dy] of PICK_RING) { const h = castAt(clientX + dx, clientY + dy, pickables); if (h.length) { o = h[0].object; break; } }
    }
    if (o && o.userData.rec) return { rec: o.userData.rec };
    if (o && o.userData.ctx) return { ctx: o.userData.ctx };
    const ch = castAt(clientX, clientY, ctxLive);
    return ch.length ? { ctx: ch[0].object.userData.ctx } : null;
  }

  // Finding what is under the pointer is the dearest thing a frame can do: a line of sight is tried against every
  // triangle of every piece it passes through, several times over, and through a skull that is dozens of dense bones
  // (14 ms a time in the Joint Atlas's head, against 0.2 ms at the knee). So it is not done while the model is being
  // dragged (nothing is pointed at then; it made dragging stutter wherever the pieces are dense), nor in a Name it
  // question (nothing lights up there), and otherwise no more often than leaves four fifths of the time for drawing.
  let hoverRec = null, hoverPending = null, hoverSet = new Set(), hoverNext = 0;
  canvas.addEventListener('pointermove', (e) => { if (e.pointerType !== 'touch') hoverPending = e.buttons ? null : { x: e.clientX, y: e.clientY }; });
  canvas.addEventListener('pointerleave', () => { hoverPending = null; setHover(null); });
  // What a click on a piece picks: its unit in the All set; in the Main set the smallest group that holds it (a gyrus
  // is in its lobe, and may be a group of its own)
  function pickTarget(rec) {
    if (state.set === 'all') return UNIT[rec.data.unit].members;
    let best = null;
    for (const g of Object.values(DATA.groups)) if (g.main && g.members.includes(rec.id) && (!best || g.members.length < best.members.length)) best = g;
    return best ? best.members : UNIT[rec.data.unit].members;
  }
  function setHover(rec) {
    if (rec === hoverRec) return;
    hoverRec = rec; $('stage').classList.toggle('hovering', !!rec);
    if (SOLID) hoverSet = new Set(rec ? pickTarget(rec).map(id => bones.get(id)).filter(Boolean) : []);
  }

  let down = null;
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; cancelFly(); });
  canvas.addEventListener('pointerup', (e) => {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    const quick = performance.now() - down.t < 650;
    down = null;
    if (moved > 7 || !quick) return;
    const p = pickAt(e.clientX, e.clientY);
    if (!p) return;
    if (p.ctx) { toast(contextNote(p.ctx)); return; }
    const rec = p.rec;
    if (e.shiftKey || state.peel) { hideBone(rec); return; }
    if (state.mode === 'study') { studyPick(rec); return; }
    if (review) { reviewPick(rec); return; }
    answer(rec);
  });
  function studyPick(rec) {
    if (!study) return;
    let idx = -1;   // the item that holds the piece: the smallest, where they nest (a gyrus in its lobe)
    study.items.forEach((it, i) => { if (it.accept.has(rec.id) && (idx < 0 || it.accept.size < study.items[idx].accept.size)) idx = i; });
    if (idx < 0 && settings.peekOutsideList === false) return;
    if (idx < 0) {
      // Not one of this set's items (a piece only the All set asks): show it anyway, as a look-up that doesn't move the list
      const u = UNIT[rec.data.unit];
      study.peek = { key: u.key, name: label(u), accept: new Set(u.members) };
      setGlow(study.peek.accept); setCallout(study.peek, rec.id); renderPrompt();
      return;
    }
    study.peek = null;
    study.index = idx;
    showStudyItem(false, rec.id);
  }
  function hideBone(rec) {
    state.hidden.add(rec.id);
    if (rec.overlay) rec.overlay.visible = false;
    applyVisibility();
    toast(t('hid', { name: lowerFirst(label(rec.data)) }));
  }

  /* ---------------- search (study) ---------------- */
  $('search').addEventListener('input', renderSearch);
  // Search matches names in the current language and in English, ignoring accents and case.
  const searchCache = new Map();
  function searchText(u) {   // a unit: its names, its group's names, and their keys (so "acl", "mcl", "spring" work)
    const k = lang.code + '|' + u.key;
    if (!searchCache.has(k)) {
      const g = DATA.groups[u.group];
      // (settings.searchText: an atlas's own choice of what a search looks through)
      searchCache.set(k, fold(settings.searchText ? settings.searchText(u, g, names)
        : [u.name, u.key, g.name, g.key, ...names(u), ...names(g)].join(' ').replace(/_/g, ' ')));
    }
    return searchCache.get(k);
  }
  function renderSearch() {
    const q = $('search').value.trim().toLowerCase();
    const list = $('searchList');
    if (!q) { list.replaceChildren(); return; }
    const terms = fold(q).split(/\s+/);
    const found = Object.values(UNIT).filter(u => inBody(BONE[u.members[0]]) && terms.every(w => searchText(u).includes(w))).slice(0, 12);
    list.replaceChildren(...found.map(u => {
      const li = document.createElement('li'); const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = label(u);
      btn.addEventListener('click', () => {
        const first = BONE[u.members[0]];
        if (!inScope(first)) { setSection(SUB[first.sub] ? `${first.region}/${first.sub}` : first.region, false); startSession(); }
        // the side nearer to where the camera is looking
        const recs = u.members.map(id => bones.get(id)).filter(Boolean); if (!recs.length) return;
        const rec = recs.reduce((b, r) => r.center.distanceTo(controls.target) < b.center.distanceTo(controls.target) ? r : b);
        if (own.searchPick) own.searchPick(u, recs); else { studyPick(rec); showBones(recs, rec); }
        document.body.classList.remove('sheet-open');
      });
      li.append(btn); return li;
    }));
  }

  /* ---------------- camera ---------------- */
  let fly = null;
  const layout = { left: 0, right: 0, top: 0, bottom: 0, w: 1, h: 1, freeW: 1, freeH: 1, fullH: 1 };
  function fitDistance(radius) {
    const t = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const half = Math.atan(t * Math.min(layout.freeW, layout.freeH) / layout.fullH);
    return radius / Math.sin(half) * 1.06;
  }
  // Camera moves orbit around the point being looked at: the direction swings round on a sphere while the
  // distance and the look-at point ease to their new values, so the camera never cuts through the skeleton.
  const sph0 = new THREE.Spherical(), sph1 = new THREE.Spherical(), sphNow = new THREE.Spherical();
  function flyTo(center, dist, dir) {
    const off = camera.position.clone().sub(controls.target);
    sph0.setFromVector3(off);
    sph1.setFromVector3(dir ? dir.clone().normalize() : off.clone().normalize());
    let dTheta = sph1.theta - sph0.theta;
    while (dTheta > Math.PI + 1e-6) dTheta -= 2 * Math.PI;
    while (dTheta < -Math.PI - 1e-6) dTheta += 2 * Math.PI;
    const turn = Math.max(Math.abs(dTheta), Math.abs(sph1.phi - sph0.phi));
    fly = {
      t0: controls.target.clone(), t1: center.clone(), r0: off.length(), r1: dist,
      th0: sph0.theta, dth: dTheta, ph0: sph0.phi, ph1: sph1.phi,
      s: performance.now(), dur: 650 + 350 * Math.min(1, turn / Math.PI),
    };
  }
  function cancelFly() { fly = null; }
  controls.addEventListener('start', cancelFly);
  // Where the camera looks from, by name. An atlas of something other than a body brings its own (settings.viewDirs:
  // name -> [x, y, z]) and says which is the usual one (settings.defaultView).
  const VIEW_DIRS = settings.viewDirs ? Object.fromEntries(Object.entries(settings.viewDirs).map(([k, v]) => [k, new THREE.Vector3(...v)])) : {
    front: new THREE.Vector3(0, 0.1, 1), back: new THREE.Vector3(0, 0.1, -1),
    left: new THREE.Vector3(1, 0.1, 0), right: new THREE.Vector3(-1, 0.1, 0),
    top: new THREE.Vector3(0, 1, 0.55),
    // the inner side of a limb joint, seen from in front and from the midline, so the camera never sits inside the trunk
    medial_l: new THREE.Vector3(-0.8, 0.15, 0.6), medial_r: new THREE.Vector3(0.8, 0.15, 0.6),
    sole: new THREE.Vector3(0, -0.55, -1),   // from behind and below: the sole of the foot, without the whole body overhead
    chin: new THREE.Vector3(0, -0.6, 1),     // from in front and below: the underside of the skull and jaw
  };
  // Views an atlas adds to the usual ones (settings.moreViewDirs: name -> [x, y, z]). One that differs between the two
  // sides of the body comes as a pair, <name>_l and <name>_r, and a unit names it without the ending.
  for (const [k, v] of Object.entries(settings.moreViewDirs || {})) VIEW_DIRS[k] = new THREE.Vector3(...v);
  // Where the camera looks at a part of the map from: the front, unless the atlas's settings say otherwise for that part
  // or its region (settings.viewFrom = { sub: { foot: 'top' }, region: { head: 'left' } }).
  function sectionDir(sec = state.section) {
    const p = parseSection(sec), from = settings.viewFrom || {};
    return VIEW_DIRS[(from.sub || {})[p.sub] || (from.region || {})[p.region] || settings.defaultView || 'front'];
  }
  function scopeSphere(key = state.view, side = state.viewSide) {
    if (own.scopeSphere) return own.scopeSphere(key);
    const box = new THREE.Box3();
    // Pieces can be long and thin, so the frame is built from their bounding boxes, not bounding spheres (a sphere round a
    // diagonal vessel is far bigger than the vessel). Pieces marked noframe (the IVC, the great saphenous vein...,
    // which run down the chest wall) are left out so the plexus zoom stays on the plexus.
    // (settings.fitAreasBy = 'spheres': the older atlases, whose pieces are compact, frame by bounding spheres)
    const add = settings.fitAreasBy === 'spheres'
      ? (r) => { box.expandByPoint(r.center.clone().addScalar(r.radius)); box.expandByPoint(r.center.clone().addScalar(-r.radius)); }
      : (r) => { if (!r.mesh.geometry.boundingBox) r.mesh.geometry.computeBoundingBox(); box.union(r.mesh.geometry.boundingBox.clone().applyMatrix4(r.mesh.matrixWorld)); };
    for (const r of bones.values()) if (inScope(r.data) && inView(r.data, key, side) && !UNIT[r.data.unit].noframe) add(r);
    if (box.isEmpty()) for (const r of bones.values()) if (inScope(r.data) && inView(r.data, key, side)) add(r);
    if (box.isEmpty()) box.copy(modelBox);
    return box.getBoundingSphere(new THREE.Sphere());
  }
  function zoomDir(key = state.view, side = state.viewSide) {
    const z = ZOOM[key];
    if (z.key === 'all') return sectionDir();
    if (z.lateral && side !== 'both') return new THREE.Vector3(side === 'left' ? 1 : -1, 0.12, 0.3);  // look at that side (head)
    if (z.lateral && z.lateral !== 'sided') return VIEW_DIRS.left;                                    // the head from the side (lateral: 'sided' = only when one side is shown)
    if (z.dir) return VIEW_DIRS[Array.isArray(z.dir) ? z.dir[side === 'right' ? 1 : 0] : z.dir];
    return z.top ? VIEW_DIRS.top : VIEW_DIRS.front;
  }
  function frameSection(dir) {
    if (own.frameSection) return own.frameSection(dir);
    autoView = '';
    const s = scopeSphere();
    flyTo(s.center, fitDistance(Math.max(s.radius, zoomed() ? 0.02 : 0)), dir || zoomDir());
  }
  function setView(key, side, frame = true) {
    own.setView?.();
    state.view = key; state.viewSide = side;
    occ.key = '';
    applyVisibility(); renderZoom();
    if (frame) frameSection();
  }
  // If the piece being shown (study step or practice reveal) is outside the zoomed area, zoom back out first; if it has
  // been peeled away by the Layers control, bring its layer back.
  function ensureInView(ids) {
    if (own.ensureInView) return own.ensureInView(ids);
    if (zoomed() && [...ids].some(id => BONE[id] && !inView(BONE[id]))) setView('all', 'both', false);
    if (settings.layersHide === false) return;
    const top = Math.min(...[...ids].map(id => BONE[id] ? BONE[id].layer : 9));
    if (top < state.layer) setLayer(top);
  }
  function zoomCount(key, side) { return DATA.bones.filter(b => inScope(b) && inView(b, key, side)).length; }
  const narrow = () => window.innerWidth <= 900;
  function setSheet(which) {   // phones: 'view', 'settings' or null (only one bottom sheet open at a time)
    document.body.classList.toggle('view-open', which === 'view');
    document.body.classList.toggle('sheet-open', which === 'settings');
    $('viewBtn').setAttribute('aria-expanded', String(which === 'view'));
  }
  function closeViewSheetOnPhone() { if (narrow()) setSheet(null); }
  function renderZoom() {
    const btn = $('viewBtn');   // phones only: shows where you're zoomed
    btn.textContent = (own.viewName && own.viewName()) || (zoomed() ? viewLabel() : t('view'));
    btn.classList.toggle('zoomed', zoomed());
    $('viewSideSeg')?.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === state.viewSide)));
    $('zoomGrid').replaceChildren(...ZOOMS.map((z, i) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'zchip'; b.dataset.zoom = z.key;
      b.setAttribute('aria-pressed', String(state.view === z.key || ZOOM[state.view].parent === z.key));
      b.disabled = zoomCount(z.key, state.viewSide) === 0;
      b.title = z.key === 'all' ? t('zoom_key1_title') : t('zoom_key_title', { k: (i + 1) % 10 });
      const l = document.createElement('span'); l.textContent = zoomLabel(z.key);
      const k = document.createElement('kbd'); k.textContent = String((i + 1) % 10);
      b.append(l, k); return b;
    }));
    own.renderZoom?.();
  }
  $('viewBtn').addEventListener('click', () => setSheet(document.body.classList.contains('view-open') ? null : 'view'));
  $('closeView').addEventListener('click', () => setSheet(null));
  $('zoomGrid').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-zoom]'); if (!b || b.disabled) return;
    setView(b.dataset.zoom, zoomCount(b.dataset.zoom, state.viewSide) ? state.viewSide : 'both');
    closeViewSheetOnPhone();
  });
  $('viewSideSeg')?.addEventListener('click', (e) => {   // (settings.sides: false = nothing here has a left and right; no such buttons)
    const v = e.target.closest('button')?.dataset.v; if (!v || !zoomCount(state.view, v)) return;
    setView(state.view, v);
  });
  // number keys: 1 whole body … 0 feet; pressing the same key again steps through both → left → right
  function zoomKey(i) {
    const z = ZOOMS[i]; if (!z) return;
    let side = 'both';
    if (settings.sides !== false && state.view === z.key) side = { both: 'left', left: 'right', right: 'both' }[state.viewSide];
    if (z.key === 'all' && state.view === 'all') side = 'both';
    for (let tries = 0; tries < 3 && !zoomCount(z.key, side); tries++) side = { both: 'left', left: 'right', right: 'both' }[side];
    if (!zoomCount(z.key, side)) { toast(t('not_in_quiz', { area: zoomLabel(z.key) })); return; }
    setView(z.key, side);
    if (state.clean || narrow()) toast(t('zoom_toast', { view: viewLabel() }));   // otherwise the View card already shows it
  }

  /* ---------------- voice commands ---------------- */
  // Say an area, optionally with a side: "knee", "left shoulder", "spine", "whole body", "zoom out"
  // (settings.voiceAreas: the words for each zoom area). Voice also reaches the areas that have no chip.
  // A command only fires when the whole phrase is a command, so narration like "the knee has four ligaments"
  // never moves the camera. Uses the browser's own speech recognition (Chrome, Edge, Safari; not Firefox).
  const VOICE_AREAS = settings.voiceAreas;
  // Sound-alikes trusted only next to "left" / "right": on their own they're ordinary words.
  const VOICE_SIDED_ONLY = settings.voiceSidedOnly || {};
  const VOICE_SIDES = { left: 'left', lift: 'left', right: 'right', write: 'right', rite: 'right', wright: 'right', both: 'both' };
  const voiceForm = (s) => s.replace(/[^a-z]/g, '').replace(/s$/, '');   // "Rib cage" = "ribcages" = "ribcage"
  const VOICE_LOOKUP = new Map(), VOICE_LOOKUP_SIDED = new Map();
  for (const [k, list] of Object.entries(VOICE_AREAS)) for (const a of list) VOICE_LOOKUP.set(voiceForm(a), k);
  for (const [k, list] of Object.entries(VOICE_SIDED_ONLY)) for (const a of list) VOICE_LOOKUP_SIDED.set(voiceForm(a), k);
  const VOICE_FILLER = new Set(['ok', 'okay', 'um', 'uh', 'so', 'now', 'and', 'hey', 'alright']);
  const VOICE_PREFIX = new Set(['zoom', 'in', 'on', 'to', 'into', 'onto', 'show', 'me', 'go', 'view', 'look', 'at', 'focus', 'the']);

  // -> { key, side } or null. side is 'both' unless left / right was said.
  function parseVoice(raw) {
    let w = String(raw).toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
    while (w.length && VOICE_FILLER.has(w[0])) w.shift();
    while (w.length && (w[w.length - 1] === 'please' || w[w.length - 1] === 'thanks')) w.pop();
    const said = own.voiceParse && own.voiceParse(w);   // an atlas's own commands ("take it apart")
    if (said) return said;
    const direct = VOICE_LOOKUP.get(voiceForm(w.join('')));
    if (direct) return { key: direct, side: 'both' };   // e.g. "zoom out", said before "zoom" is treated as a prefix
    while (w.length > 1 && VOICE_PREFIX.has(w[0])) w.shift();
    let side = null, saidSide = false;
    if (w.length && VOICE_SIDES[w[0]]) {                 // "left foot", "left side of the spine", "both feet"
      side = VOICE_SIDES[w.shift()];
      while (w.length && ['side', 'sides', 'of', 'the'].includes(w[0])) { saidSide = saidSide || w[0].startsWith('side'); w.shift(); }
    } else {                                             // "foot left", "rib cage on the right side"
      if (w.length > 1 && /^sides?$/.test(w[w.length - 1])) { w.pop(); saidSide = true; }
      if (w.length > 1 && VOICE_SIDES[w[w.length - 1]]) {
        side = VOICE_SIDES[w.pop()];
        while (w.length > 1 && ['on', 'the'].includes(w[w.length - 1])) w.pop();
      } else if (saidSide) return null;
    }
    if (!w.length) return side && saidSide && settings.sides !== false ? { key: state.view, side } : null;   // "left side": same area, that side
    const f = voiceForm(w.join(''));
    const key = VOICE_LOOKUP.get(f) || (side && side !== 'both' ? VOICE_LOOKUP_SIDED.get(f) : null);
    return key ? { key, side: side || 'both' } : null;
  }

  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  // Safari runs one phrase per session (its continuous mode keeps adding to a single transcript), so it restarts after each.
  const VOICE_ONE_SHOT = /^((?!chrome|chromium|crios|android|edg|fxios).)*safari/i.test(navigator.userAgent);
  const voice = { on: false, rec: null, startedAt: 0, gotResult: false, quickEnds: 0, fired: new Map(), steady: 0, restart: 0 };
  function voiceStatus(text, kind) {
    const el = $('voiceHeard');
    el.textContent = text; el.className = 'voice-heard' + (kind ? ' ' + kind : ''); el.hidden = !text;
  }
  function setVoice(on, reason) {
    if (on && !SpeechRec) {
      toast(t('voice_need'), 'bad');
      return;
    }
    voice.on = on;
    $('voiceBtn').setAttribute('aria-pressed', String(on));
    clearTimeout(voice.restart); clearTimeout(voice.steady);
    if (on) {
      voice.quickEnds = 0;
      voiceStatus(t('voice_listening'));
      voiceStart();
    } else {
      const rec = voice.rec; voice.rec = null;
      if (rec) { try { rec.abort(); } catch (e) { /* already stopped */ } }
      voiceStatus(reason || '', reason ? 'bad' : '');
      if (reason && (state.clean || narrow())) toast(reason, 'bad');
    }
  }
  function voiceStart() {
    if (!voice.on || voice.rec || document.hidden) return;
    const rec = new SpeechRec();
    rec.lang = /^en\b/i.test(navigator.language || '') ? navigator.language : 'en-US';
    rec.continuous = !VOICE_ONE_SHOT;
    rec.interimResults = true;
    rec.maxAlternatives = 3;
    voice.rec = rec; voice.fired = new Map(); voice.startedAt = performance.now(); voice.gotResult = false;
    rec.onresult = (e) => { if (voice.rec === rec) onVoiceResult(e, rec); };
    rec.onerror = (e) => {
      if (voice.rec !== rec) return;
      const stop = {
        'not-allowed': 'voice_not_allowed', 'service-not-allowed': 'voice_service',
        'audio-capture': 'voice_no_mic', 'language-not-supported': 'voice_lang',
      }[e.error];
      if (stop) { setVoice(false, t(stop)); return; }
      if (e.error === 'network') voiceStatus(t('voice_network'), 'bad');
      // 'no-speech' and 'aborted' are routine: the end handler restarts listening
    };
    rec.onend = () => {
      if (voice.rec !== rec) return;
      voice.rec = null;
      if (!voice.on) return;
      // keep listening; back off if the recognizer keeps stopping straight away (offline, service trouble)
      const quick = !voice.gotResult && performance.now() - voice.startedAt < 1500;
      voice.quickEnds = quick ? voice.quickEnds + 1 : 0;
      voice.restart = setTimeout(voiceStart, quick ? Math.min(8000, 250 * 2 ** voice.quickEnds) : 60);
    };
    try { rec.start(); } catch (err) { voice.rec = null; voice.restart = setTimeout(voiceStart, 500); }
  }
  function onVoiceResult(e, rec) {
    voice.gotResult = true;
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      const alts = []; for (let j = 0; j < r.length; j++) alts.push(String(r[j].transcript || '').trim());
      const text = alts[0] || '';
      if (!text) continue;
      let cmd = null; for (const a of alts) if ((cmd = parseVoice(a))) break;
      const prev = voice.fired.get(i);
      clearTimeout(voice.steady);
      if (r.isFinal) {
        if (cmd && !(prev && prev.key === cmd.key && (settings.sides === false || prev.side === cmd.side) && prev.act === cmd.act)) voiceDo(cmd, text);
        else if (!cmd && !prev) voiceStatus(t('voice_not_cmd', { text }));
        voice.fired.set(i, cmd || prev || { key: null });
      } else if (!prev) {
        voiceStatus(t('voice_partial', { text }));
        // act before the browser finalises the phrase if the words so far are a command and stay that way briefly
        if (cmd) voice.steady = setTimeout(() => { if (voice.rec === rec && !voice.fired.has(i)) { voice.fired.set(i, cmd); voiceDo(cmd, text); } }, 350);
      }
    }
  }
  function voiceDo(cmd, text) {
    if (pendingConfirm) return;   // the end-test question is up: ignore speech
    if (own.voiceDo && own.voiceDo(cmd, text)) return;   // one of the atlas's own (it says so by returning true)
    let side = settings.sides === false ? 'both' : cmd.side;
    if (!zoomCount(cmd.key, side)) side = 'both';
    if (!zoomCount(cmd.key, side)) { voiceStatus(t('voice_not_in_quiz', { text, area: zoomLabel(cmd.key) }), 'bad'); return; }
    if (state.view === cmd.key && state.viewSide === side) frameSection(); else setView(cmd.key, side);
    voiceStatus(t('voice_did', { text, view: viewLabel() }), 'ok');
    if (state.clean || narrow()) toast(t('zoom_toast', { view: viewLabel() }));
  }
  $('voiceBtn').addEventListener('click', () => setVoice(!voice.on));
  document.addEventListener('visibilitychange', () => { if (!document.hidden && voice.on && !voice.rec) voiceStart(); });
  /* Move the camera only when the item would be hard to see: too small, off-screen, or too big. */
  const tmpV = new THREE.Vector3();
  function projectPx(p) {
    tmpV.copy(p).project(camera);
    return { x: (tmpV.x + 1) / 2 * layout.w, y: (1 - tmpV.y) / 2 * layout.h, behind: tmpV.z > 1 };
  }
  function pxPerMeterAt(p) {
    const d = camera.position.distanceTo(p);
    return layout.fullH / (2 * d * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  }
  function inFree(pt, margin = 30) {
    return !pt.behind && pt.x > layout.left + margin && pt.x < layout.w - layout.right - margin && pt.y > layout.top + margin && pt.y < layout.h - layout.bottom - margin;
  }
  /* Standard views. Every piece has one: the zoom area it belongs to, at the same distance as that area's 1–0 key,
     looked at from the side it is best seen from (set in the atlas's data: front, back, its own side, the other side, the top
     of the foot, the sole, or from under the chin). Limbs are framed one side at a time; the head and torso whole.
     Stepping to a piece moves the camera only when the area or angle changes or the piece is off screen, so a view you
     rotated by hand is kept while you stay in that area. */
  // (the areas framed one side at a time: those marked `one`, unless settings.oneSideViews lists them)
  const ONE_SIDE_AREAS = new Set(settings.oneSideViews || ZOOMS.concat(ZOOMS_VOICE).filter(z => z.one).map(z => z.key));
  let autoView = '';   // the standard view the camera last moved to; cleared by any other framing
  function areaFor(d) {
    // the smallest area the piece is in: a voice-only area that is part of another (the foot), then a part of a region
    // (with a chip, or voice-only), then a whole region. settings.voiceAreasInViews = false: only areas with a chip.
    // settings.areaBySection (Bone): by the part of the map alone, whatever an area's `match` says
    if (settings.areaBySection) return ZOOMS.find(z => z.sec.includes('/') && inSection(d, z.sec)) || ZOOMS.find(z => z.key !== 'all' && inSection(d, z.sec)) || ZOOM.all;
    const spoken = settings.voiceAreasInViews === false ? [] : ZOOMS_VOICE;
    return spoken.find(z => z.match && inView(d, z.key, 'both'))
      || ZOOMS.find(z => z.key !== 'all' && z.sec.includes('/') && inView(d, z.key, 'both'))
      || spoken.find(z => z.sec.includes('/') && inView(d, z.key, 'both'))
      || ZOOMS.find(z => z.key !== 'all' && inView(d, z.key, 'both'))
      || spoken.find(z => inView(d, z.key, 'both'))
      || ZOOM.all;
  }
  const sideOf = (r) => r.data.side === 'L' ? 'left' : r.data.side === 'R' ? 'right' : null;
  function standardView(members, focus) {
    const f = focus || members[0];
    const z = areaFor(f.data);
    // the piece's own side; for a left + right pair, whichever is nearer to where the camera is looking
    const sided = members.filter(sideOf);
    const pick = focus && sideOf(focus) ? focus
      : sided.length ? sided.reduce((b, r) => r.center.distanceTo(controls.target) < b.center.distanceTo(controls.target) ? r : b) : null;
    let side = ONE_SIDE_AREAS.has(z.key) && pick ? sideOf(pick) : 'both';
    if (!zoomCount(z.key, side)) side = 'both';
    const v = UNIT[f.data.unit].view, own = pick ? sideOf(pick) : 'left';
    // 'side' looks at the piece's own side, 'medial' from the body's midline side (the other side of the body)
    const turn = v === 'side' ? own : v === 'medial' ? 'medial_' + own[0] : v === 'front' ? null : v === 'below' ? 'chin'
      : VIEW_DIRS[v + '_' + own[0]] ? v + '_' + own[0] : v;
    return { key: z.key, side, turn };
  }
  function onScreen(members, focus) {
    const t = focus || members.reduce((b, r) => r.radius > b.radius ? r : b, members[0]);
    const p = projectPx(t.center);
    return !p.behind && inFree(p, 20) && t.radius * pxPerMeterAt(t.center) >= 8;
  }
  // Bring the piece(s) being shown into view: a study step, a practice reveal, a search result.
  function showBones(members, focus) {
    if (!members.length) return;
    if (own.showBones) return own.showBones(members, focus);
    if (zoomed()) { if (!onScreen(members, focus)) frameSection(); return; }   // keep the zoom area the person picked
    const v = standardView(members, focus), id = [v.key, v.side, v.turn].join('|');
    if (id === autoView && onScreen(members, focus)) return;
    const sph = scopeSphere(v.key, v.side);
    flyTo(sph.center, fitDistance(Math.max(sph.radius, 0.02)), v.turn ? VIEW_DIRS[v.turn] : zoomDir(v.key, v.side));
    autoView = id;
  }
  document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => {
    const t = controls.target.clone();
    flyTo(t, camera.position.distanceTo(t), VIEW_DIRS[b.dataset.view]);
    closeViewSheetOnPhone();
  }));

  /* ---------------- UI rendering ---------------- */
  function fmtTime(ms) { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
  // Long names shrink to fit on one line (down to 45%, never below 14px) so the prompt is the same height for every
  // question. 45% leaves room for the longest German names, e.g. "Concha nasalis inferior links (untere Nasenmuschel)".
  function fitName() {
    const el = $('pName');
    el.style.fontSize = ''; el.style.whiteSpace = 'nowrap';
    const base = parseFloat(getComputedStyle(el).fontSize) || 28;
    el.style.lineHeight = (base * 1.1).toFixed(1) + 'px';
    const avail = el.clientWidth;
    if (!avail) return;
    const min = Math.min(base, Math.max(14, base * 0.45));
    let size = base;
    for (let i = 0; i < 6 && el.scrollWidth > avail + 1 && size > min; i++) {
      size = Math.max(min, size * (avail / el.scrollWidth) * 0.98);
      el.style.fontSize = size.toFixed(1) + 'px';
    }
    if (el.scrollWidth > avail + 1) el.style.whiteSpace = 'normal';
  }
  function setTip(text) { const t = $('pTip'); t.hidden = !text; t.textContent = text || ''; }
  // Study: a few labelled lines about the piece (settings.noteRows: which, in what order), from the notes in the data.
  // A branch without its own note uses its group's.
  function noteFor(key) { return DATA.notes[key] || (UNIT[key] && DATA.notes[UNIT[key].group]) || null; }
  function setNote(note) {
    const el = $('pTip'); el.hidden = false;
    const parts = [];
    const rows = settings.noteRows.filter(k => note[k]);
    rows.forEach((k, i) => {
      const b = document.createElement('b'); b.textContent = t((settings.noteLabelPrefix || '') + k) + ' ';
      parts.push(b, document.createTextNode(note[k] + ' '));
      if (i < rows.length - 1 && settings.noteBreaks !== false) parts.push(document.createElement('br'));   // a row to a line (noteBreaks: false runs them on)
    });
    el.replaceChildren(...parts);
  }
  function renderPrompt() { renderPromptText(); fitName(); fitAnswer(); }
  function renderPromptText() {
    const pr = $('prompt');
    pr.classList.toggle('is-reveal', !!session && session.phase === 'reveal');
    const q = isolated() ? session.name : null;   // a Name it question: the answer box takes the name's place
    if (NAME) {
      $('answer').hidden = !q; $('pName').hidden = !!q;
      pr.classList.toggle('is-right', !!q && (q.verdict === 'right' || q.verdict === 'close'));
      pr.classList.toggle('is-wrong', !!q && q.verdict === 'wrong');
      pr.classList.toggle('has-note', !!q && !!q.wrong && !q.verdict);
    }
    const secLabel = sectionLabel();
    if (state.mode === 'study') {
      if (own.prompt && own.prompt()) return;
      if (!study || !study.items.length) {
        $('pEyebrow').textContent = t('mode_study'); $('pName').textContent = t('nothing_to_study'); $('pMeta').textContent = secLabel; setTip(''); return;
      }
      if (study.cleared && settings.deselectKeepsPlace) {
        $('pEyebrow').textContent = t('study_eyebrow', { sec: secLabel }); $('pName').textContent = t('study_none');
        $('pMeta').textContent = t('study_meta', { i: study.index + 1, n: study.items.length });
        setTip(''); $('pBar').style.width = (100 * (study.index + 1) / study.items.length).toFixed(1) + '%'; return;
      }
      if (study.cleared) {
        $('pEyebrow').textContent = t('mode_study'); $('pName').textContent = secLabel; $('pMeta').textContent = t('cleared_meta'); setTip(sectionTip()); $('pBar').style.width = '0%'; return;
      }
      const it = study.peek || study.items[study.index];
      $('pEyebrow').textContent = t('study_eyebrow', { sec: secLabel });
      $('pName').textContent = it.name;
      $('pMeta').textContent = study.peek ? t('peek_meta', { all: DATA.counts.all }) : t('study_meta', { i: study.index + 1, n: study.items.length });
      const note = noteFor(it.key);
      // (the Notes switch: off, the card is the name alone; on, the piece's notes, or the part's tip where it has none)
      if (!state.notes) $('pTip').hidden = true; else if (note) setNote(note); else setTip(sectionTip());
      $('pBar').style.width = (100 * (study.index + 1) / study.items.length).toFixed(1) + '%';
      return;
    }
    setTip('');
    if (!session) return;
    const test = state.mode === 'test';
    if (!session.total) {
      $('pEyebrow').textContent = t(test ? 'mode_test' : 'mode_practice'); $('pName').textContent = t('no_bones'); $('pMeta').textContent = secLabel; return;
    }
    $('review').hidden = !review; $('pBarWrap').hidden = !!review; $('skipBtn').hidden = !!review || naming();
    if (review) {
      $('pEyebrow').textContent = `${t(test ? 'test_complete' : 'set_learned')} · ${secLabel}`;
      $('pName').textContent = `${review.ok} / ${session.total}`;
      $('pMeta').textContent = t('review_meta', { acc: review.acc, time: fmtTime(review.ms), s: review.best.score, t: review.best.total });
      return;
    } else if (!session.current) {
      $('pEyebrow').textContent = t(test ? 'test_finished' : 'set_learned');
      $('pName').textContent = t('x_of_y', { a: session.total - session.everMissed.size, b: session.total });
    } else if (q) {
      $('pEyebrow').textContent = t(q.verdict ? 'name_' + q.verdict : 'name_eyebrow');
      renderAnswer();
    } else if (session.phase === 'reveal') {
      $('pEyebrow').textContent = t('reveal_eyebrow');
      $('pName').textContent = session.current.name;
    } else {
      $('pEyebrow').textContent = t('find_the');
      $('pName').textContent = session.current.name;
    }
    const answered = session.total - session.queue.length - (session.current ? 1 : 0);
    $('pMeta').textContent = `${secLabel} · ${test ? t('answered', { a: answered, t: session.total }) : t('learned', { a: session.done, t: session.total })}`;
    // (after a wrong answer in Practice: what was typed, until the next key)
    if (q && q.wrong && !q.verdict) $('pMeta').textContent = t('name_not', { text: q.wrong.length > 34 ? q.wrong.slice(0, 33) + '…' : q.wrong });
    const frac = state.mode === 'test' ? answered / session.total : session.done / session.total;
    $('pBar').style.width = (100 * frac).toFixed(1) + '%';
  }
  let promptTimer = 0;
  function pulsePrompt(kind) {
    const pr = $('prompt'); pr.classList.remove('is-ok', 'is-bad'); pr.classList.add(kind === 'ok' ? 'is-ok' : 'is-bad');
    clearTimeout(promptTimer); promptTimer = setTimeout(() => pr.classList.remove('is-ok', 'is-bad'), 600);
  }
  function renderStats() {
    const s = session;
    $('sAcc').textContent = s && s.attempts ? t('pct', { n: Math.round(100 * s.correct / s.attempts) }) : '–';
    $('sStreak').textContent = s ? s.streak : 0;
    if (!s) $('sTime').textContent = '0:00';
  }
  function renderRail() {
    const rail = $('rail');
    const cur = parseSection(state.section);
    const mk = (sec, label, cls) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.dataset.sec = sec;
      b.setAttribute('aria-pressed', String(state.section === sec));
      const l = document.createElement('span'); l.textContent = label;
      const n = document.createElement('em'); n.textContent = countFor(sec);
      b.append(l, n); return b;
    };
    const title = document.createElement('div'); title.className = 'rail-title'; title.textContent = t('rail_title');
    const kids = [title, mk('all', t('whole_body'), 'rg')];
    for (const r of DATA.regions) {
      const g = document.createElement('div'); g.className = 'rgroup' + (cur.region === r.key ? ' open' : '');
      const subs = document.createElement('div'); subs.className = 'subs';
      if (!r.subs[0]?.only) subs.append(...r.subs.filter(inBody).map(s => mk(`${r.key}/${s.key}`, subLabel(s.key), 'sb')));   // a region with no parts has one, unlisted
      g.append(mk(r.key, regionLabel(r.key), 'rg'), subs);
      kids.push(g);
    }
    rail.replaceChildren(...kids);
    scrollRailToSelection();
  }
  // on phones the map is a scrolling row: keep the selected chip in view
  function scrollRailToSelection() {
    const rail = $('rail'), sel = rail.querySelector('[aria-pressed="true"]');
    if (sel && rail.scrollWidth > rail.clientWidth) {
      rail.scrollLeft = Math.max(0, sel.getBoundingClientRect().left - rail.getBoundingClientRect().left + rail.scrollLeft - 24);
    }
  }
  $('rail').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-sec]'); if (!b) return;
    const sec = b.dataset.sec;
    guardTest(sec === state.section ? t('what_restart') : t('what_section', { sec: sectionLabel(sec) }), () => { setSection(sec); startSession(); });
  });

  /* ---------------- confirm before throwing away a test in progress ---------------- */
  // Practice isn't guarded: every practice answer is already saved to the per-piece history as you go.
  function testInProgress() { return state.mode === 'test' && !!session && !session.end && !!session.current && session.attempts > 0; }
  let pendingConfirm = null;
  // Runs `action` right away, unless a test is under way: then it asks first. The clock stops while the question is up.
  function guardTest(what, action) {
    if (!testInProgress()) { action(); return; }
    const answered = session.total - session.queue.length - 1;
    $('confirmMsg').textContent = t('confirm_msg', { a: answered, n: session.total, sec: sectionLabel(), what });
    pendingConfirm = { action, t0: performance.now() };
    $('confirm').hidden = false;
    $('confirmNo').focus();
  }
  function closeConfirm(go) {
    const p = pendingConfirm; if (!p) return;
    pendingConfirm = null;
    $('confirm').hidden = true;
    if (go) { setSheet(null); p.action(); }
    else if (session && !session.end) session.start += performance.now() - p.t0;   // time spent deciding doesn't count
  }
  $('confirmYes').addEventListener('click', () => closeConfirm(true));
  $('confirmNo').addEventListener('click', () => closeConfirm(false));
  $('confirm').addEventListener('click', (e) => { if (e.target === $('confirm')) closeConfirm(false); });
  $('homeLink').addEventListener('click', (e) => {
    if (!testInProgress()) return;
    e.preventDefault();
    const href = e.currentTarget.href;
    guardTest(t('what_leave'), () => { location.href = href; });
  });
  function renderSegs() {
    for (const [id, val] of [['modeSeg', state.mode], ['setSeg', state.set], ['hintSeg', state.hints ? 'on' : 'off'], ['notesSeg', state.notes ? 'on' : 'off']]) {
      $(id).querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === val)));
    }
    $('modeHint').textContent = t((naming() ? 'hint_name_' : 'hint_') + state.mode);
    $('notesBox').hidden = state.mode !== 'study';   // (notes are Study's: the switch is there only then)
    if (NAME) {
      $('quizBox').hidden = state.mode === 'study';
      $('quizSeg').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === state.quiz)));
    }
    if (settings.bodies) {   // how many there are depends on the body
      const nMain = DATA.counts['main_' + state.sex.toLowerCase()], nAll = DATA.counts['all_' + state.sex.toLowerCase()];
      $('setSeg').querySelector('[data-v="names"]').textContent = t('set_names', { n: nMain });
      $('setSeg').querySelector('[data-v="all"]').textContent = t('set_all', { n: nAll });
      $('setHint').textContent = t(state.set === 'all' ? 'set_hint_all' : 'set_hint_names', { n: state.set === 'all' ? nAll : nMain });
    } else if ($('setHint')) $('setHint').textContent = t(state.set === 'all' ? 'set_hint_all' : 'set_hint_names');
    $('hintHint').textContent = t(state.hints ? 'hints_hint_on' : 'hints_hint_off');
    $('searchBox').hidden = state.mode !== 'study';
    // the key help is our own markup (<kbd> tags) from the text table, not user input
    // (in a Name it question the keys type the answer, so only its own are listed)
    $('keysHint').innerHTML = (naming() ? t('keys_name_' + state.mode) : `${t(state.mode === 'study' ? 'keys_study' : 'keys_quiz')} · ${t('keys_common')}`) + ` · ${t('keys_turn')}`;
    const studying = state.mode === 'study';
    $('prevBtn').hidden = !studying; $('nextBtn').hidden = !studying;
    $('skipBtn').hidden = studying || naming();   // (Name it has its own, beside the answer box)
    $('skipBtn').textContent = t(state.mode === 'test' ? 'skip' : 'show_me');
    $('stats').hidden = studying;
  }
  function renderBest() {
    const b = store.get('best', {})[bestKey()];
    const el = $('best');
    if (state.mode === 'study') { el.textContent = ''; return; }
    if (!b) { el.textContent = t('best_none'); return; }
    el.innerHTML = t('best_here', { s: b.score, t: b.total, time: fmtTime(b.ms) });
  }
  function setMode(m, restart = true) {
    own.modeChanging?.(m);
    state.mode = m; store.set('mode', m);
    own.modeChanged?.(m);
    renderSegs(); renderBest(); resize();
    if (restart) startSession();
  }
  function setSection(sec, frame = true) {
    state.section = sec; store.set('section', sec);
    state.view = 'all'; state.viewSide = 'both'; renderZoom();
    applyVisibility(); renderRail(); renderBest();
    if (frame) frameSection();
  }
  // Rename the items being studied or quizzed in place (hints or language changed); the session carries on.
  function relabelItems() {
    for (const it of [...(study ? study.items : []), ...(session ? session.items : [])]) it.name = itemLabel(it.key);
    if (review) setCallout(null);
    else if (callout.item) $('callout').textContent = callout.item.name;
  }
  function setHints(on) {
    if (state.hints === on) return;
    state.hints = on; store.set('hints', on);
    relabelItems();
    renderSegs(); renderPrompt(); renderBest(); renderSearch();
    toast(t(on ? 'toast_hints_on' : 'toast_hints_off'));
  }
  $('hintSeg').addEventListener('click', (e) => { const v = e.target.closest('button')?.dataset.v; if (v) setHints(v === 'on'); });
  // The Notes switch (#notesSeg): Study's lines about each piece, shown or not. The name alone is the default.
  $('notesSeg').addEventListener('click', (e) => {
    const v = e.target.closest('button')?.dataset.v; if (!v || state.notes === (v === 'on')) return;
    state.notes = v === 'on'; store.set('notes', state.notes);
    renderSegs(); renderPrompt(); resize();
  });
  $('modeSeg').addEventListener('click', (e) => {
    const v = e.target.closest('button')?.dataset.v; if (!v || v === state.mode) return;
    guardTest(t('what_mode', { mode: t('mode_' + v) }), () => setMode(v));
  });
  $('setSeg').addEventListener('click', (e) => {
    const v = e.target.closest('button')?.dataset.v; if (!v || v === state.set) return;
    guardTest(t(v === 'all' ? 'what_all' : 'what_names'), () => {
      state.set = v; store.set('set', v); renderSegs(); renderRail(); renderBest(); startSession();
    });
  });
  function setXray(on) {
    state.xray = on;
    $('xrayBtn').setAttribute('aria-pressed', String(on));
    applyVisibility();
  }
  $('xrayBtn').addEventListener('click', () => setXray(!state.xray));
  // Layers, for an atlas that has them (settings.layers; each piece's layer is in its data): 1 = everything, 2 and 3 hide
  // what covers the deeper pieces, so they can be found in Practice without X-ray. In the Heart Atlas: 2 = veins hidden,
  // 3 = only the inside of the heart.
  function setLayer(n, say = false) {
    state.layer = n;
    $('layerSeg')?.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.v) === n)));
    occ.key = '';
    applyVisibility();
    if (say) toast(pair('layer_toast')[n - 1]);
  }
  // The Body control (settings.bodies): switches between the male and female pieces, and starts the round again
  function setSex(v, say = false) {
    if (v === state.sex) return;
    const go = () => {
      state.sex = v; store.set('sex', v);
      $('sexSeg').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
      const p = parseSection(state.section);
      if (p.sub && SUB[p.sub].sex && SUB[p.sub].sex !== v) setSection(p.region, false);   // the other body's part: step up to its system
      occ.key = '';
      applyVisibility(); renderSegs(); renderRail(); renderZoom(); renderBest(); renderSearch();
      startSession();
      if (say) toast(pair('body_toast')[v === 'M' ? 0 : 1]);
    };
    guardTest(t('what_body', { body: t(v === 'M' ? 'body_m' : 'body_f') }), go);
  }
  if (settings.bodies) {
    $('sexSeg').addEventListener('click', (e) => { const v = e.target.closest('button')?.dataset.v; if (v) setSex(v); });
    $('sexSeg').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === state.sex)));
  }
  // (a page without a Layers control or a Bones button simply doesn't have that feature: Bone Atlas)
  $('layerSeg')?.addEventListener('click', (e) => { const v = Number(e.target.closest('button')?.dataset.v); if (v) setLayer(v); });
  function setBonesShown(on) {
    state.bones = on; store.set('bones', on);
    $('bonesBtn')?.setAttribute('aria-pressed', String(on));
    applyVisibility();
  }
  $('bonesBtn')?.addEventListener('click', () => setBonesShown(!state.bones));
  $('peelBtn').addEventListener('click', () => { state.peel = !state.peel; $('peelBtn').setAttribute('aria-pressed', String(state.peel)); toast(t(state.peel ? 'peel_on' : 'peel_off')); });
  $('unhideBtn').addEventListener('click', () => { state.hidden.clear(); applyVisibility(); closeViewSheetOnPhone(); });
  $('resetBtn').addEventListener('click', () => { if (own.resetView) own.resetView(); else frameSection(); closeViewSheetOnPhone(); });
  $('restartBtn').addEventListener('click', () => guardTest('Restarting', () => startSession()));
  $('skipBtn').addEventListener('click', skip);
  $('prevBtn').addEventListener('click', () => studyStep(-1));
  $('nextBtn').addEventListener('click', () => studyStep(1));
  $('settingsBtn').addEventListener('click', () => setSheet('settings'));
  $('closeSheet').addEventListener('click', () => setSheet(null));
  function setClean(on) { state.clean = on; document.body.classList.toggle('clean', on); resize(); }

  /* ---------------- language switch ---------------- */
  // /js/language.js runs the menu and puts the page's fixed text (data-i18n) in the new language; everything this
  // code draws is drawn again.
  lang.onChange(() => {
    everyName = null;
    relabelItems();
    if (review) renderReviewLabels();
    renderSegs(); renderRail(); renderZoom(); renderPrompt(); renderStats(); renderBest(); renderSearch();
    applyVisibility();   // "Show N hidden pieces"
    if (voice.on) voiceStatus(t('voice_listening'));
    drawPlatform();
    own.language?.();
    resize();
  });
  $('cleanBtn').addEventListener('click', () => { setClean(true); setSheet(null); });
  $('cleanExit').addEventListener('click', () => setClean(false));

  // Control, pressed and let go on its own, turns the view a quarter of the way round: the camera goes 90° round what
  // it is looking at (front, the body's left side, back, right side). It is the one key that works while a name is
  // being typed, where every letter types. A Control held for something else (Ctrl+C, Ctrl with the wheel or a drag)
  // turns nothing. Pressed again before the turn is over, it goes on from where that turn ends.
  // Each press adds a quarter turn to where the camera is going and the camera carries on from where it is (it used to
  // jump to the end of the turn under way, which blinked): two quick presses are one smooth half turn. A quarter takes
  // 0.4 s, half what a flight to a view takes.
  function turnView() {
    const off = camera.position.clone().sub(controls.target);
    sph0.setFromVector3(off);
    const going = fly && fly.turn;
    let dth = (fly ? fly.th0 + fly.dth : sph0.theta) + Math.PI / 2 - sph0.theta;   // (the long way round, when turns have piled up)
    dth = ((dth % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI;
    fly = {
      t0: controls.target.clone(), t1: fly ? fly.t1.clone() : controls.target.clone(), r0: off.length(), r1: fly ? fly.r1 : off.length(),
      th0: sph0.theta, dth, ph0: sph0.phi, ph1: fly ? fly.ph1 : sph0.phi,
      s: performance.now(), dur: 410 * dth / (Math.PI / 2), turn: true, out: going,   // (out: already moving, so no easing in again)
    };
  }
  let ctrlAlone = false;
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Control') ctrlAlone = false;
    else if (!e.repeat) ctrlAlone = !pendingConfirm && !e.shiftKey && !e.altKey && !e.metaKey;
  });
  window.addEventListener('keyup', (e) => { if (e.key === 'Control' && ctrlAlone) { ctrlAlone = false; turnView(); } });
  for (const type of ['pointerdown', 'wheel', 'blur']) window.addEventListener(type, () => { ctrlAlone = false; }, { passive: true });
  window.addEventListener('keydown', (e) => {
    if (pendingConfirm) {   // while the end-test question is up, only Esc / Tab / Enter on its buttons do anything
      if (e.key === 'Escape') { e.preventDefault(); closeConfirm(false); }
      else if (e.key === 'Tab') { e.preventDefault(); (document.activeElement === $('confirmNo') ? $('confirmYes') : $('confirmNo')).focus(); }
      return;
    }
    if (e.target.closest && e.target.closest('input, textarea')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (present.on) {   // (the presentation, below: only its own keys act)
      if (k === ' ') { e.preventDefault(); present.paused = !present.paused; controls.autoRotate = !present.paused; }
      else if (k === 'l' && LABELS) setLabels(!present.labels);
      else if (k === 's' || k === 'escape') setPresent(false);
      return;
    }
    if (k === 's' && state.mode === 'study' && !review) { setPresent(true); return; }
    // A Name it question: the keys type the answer, wherever the cursor was left (after turning the model, say)
    if (isolated() && k !== 'escape') {
      const onButton = !!(e.target.closest && e.target.closest('button, select, a'));   // (Enter and Space press a button that has the focus)
      if (k === 'enter') { if (!onButton) { e.preventDefault(); submitName(); } }
      else if ((e.key.length === 1 && !(k === ' ' && onButton)) || k === 'backspace') $('answerBox').focus({ preventScroll: true });
      return;
    }
    if (k === 'arrowright' || (k === ' ' && state.mode === 'study')) { if (state.mode === 'study') { e.preventDefault(); studyStep(1); } }
    else if (k === 'arrowleft') { if (state.mode === 'study') { e.preventDefault(); studyStep(-1); } }
    else if (k === 's') skip();
    else if (k === 'x') setXray(!state.xray);
    else if (k === 'l' && settings.layers) setLayer(state.layer % (settings.layers === true ? 3 : settings.layers) + 1, true);   // layers: true = three, or how many
    else if (k === 'g' && settings.bodies) setSex(state.sex === 'M' ? 'F' : 'M', true);
    else if (own.key && own.key(k)) { /* one of the atlas's own keys */ }
    else if (k === 'b' && $('bonesBtn')) setBonesShown(!state.bones);
    else if (k === 'h') setHints(!state.hints);
    else if (k === 'v') setVoice(!voice.on);
    else if (/^[0-9]$/.test(k)) zoomKey((Number(k) + 9) % 10);
    else if (k === 'c') setClean(!state.clean);
    else if (k === 'r') { if (own.resetView) own.resetView(); else frameSection(); }
    else if (k === 'escape') {
      const sheetOpen = /(^|\s)(sheet|view)-open(\s|$)/.test(document.body.className);
      if (sheetOpen) setSheet(null);
      else if (own.stop && own.stop()) { /* Esc first stops what was running */ }
      else if (settings.escClearsSelection !== false && state.mode === 'study' && study && (study.peek || glowing.length)) clearStudySelection();   // first Esc: clear the selection
      else if (zoomed()) { if (own.zoomOut) own.zoomOut(); else setView('all', 'both'); }                    // then zoom back out
      else if (state.clean) setClean(false);
    }
    else if (k === 'enter' && session && session.phase === 'reveal') { clearQuizVisuals(); nextItem(); }
  });

  let toastTimer = 0;
  function toast(msg, kind) {
    const t = $('toast'); t.textContent = msg; t.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = 'toast'; }, 2600);
  }

  /* ---------------- layout ---------------- */
  // The 3D view is full-bleed, but the prompt, region map, dock and (desktop) panel cover parts of it.
  // The projection is shifted so the skeleton is centred in the uncovered area and fitted to it.
  function measureInsets() {
    const w = window.innerWidth, h = window.innerHeight, wide = w > 900;
    const vis = (el) => el && !el.hidden && el.offsetParent !== null;
    let top = 0, bottom = 0, left = 0, right = 0;
    const tops = ['prompt', 'stats'].concat(wide ? [] : ['rail']);
    for (const id of tops) { const el = $(id); if (vis(el)) top = Math.max(top, el.getBoundingClientRect().bottom + 6); }
    // Study shows a few lines about the piece in the prompt; Practice and Test don't. Reserve them either way, so the
    // body stays put when switching modes.
    if (wide && $('pTip').hidden && $('review').hidden && vis($('prompt'))) {
      const tip = getComputedStyle($('pTip')), gap = parseFloat(getComputedStyle($('prompt')).rowGap) || 4;
      let room = Math.max(parseFloat(tip.minHeight) || 0, parseFloat(tip.lineHeight) || 18) + (parseFloat(tip.marginTop) || 0) + gap;
      // (a Name it answer line is taller than a name: it takes its extra height out of that reserve, so the body is
      // where it is in the other questions)
      if (NAME && vis($('answer'))) room = Math.max(0, room - Math.max(0, $('answer').offsetHeight - (parseFloat($('pName').style.lineHeight) || 0)));
      top += room;
    }
    const dockBtns = [...document.querySelectorAll('.dock .btn')].filter(vis);
    if (dockBtns.length) bottom = h - Math.min(...dockBtns.map(b => b.getBoundingClientRect().top)) + 6;
    if (wide && !state.clean) {
      if (vis($('panel'))) right = w - $('panel').getBoundingClientRect().left + 8;
      for (const id of ['rail', 'viewCard']) if (vis($(id))) left = Math.max(left, $(id).getBoundingClientRect().right + 8);
    }
    // a phone's keyboard, up for a Name it answer, covers the bottom of the page: the model is fitted above it
    const vv = NAME && window.visualViewport, keyboard = vv ? h - vv.height - vv.offsetTop : 0;
    if (keyboard > 120) return { w, h, top: Math.min(top, h * 0.45), bottom: Math.min(keyboard, h * 0.6), left: 0, right: 0 };
    return { w, h, top: Math.min(top, h * 0.45), bottom: Math.min(bottom, h * 0.3), left: Math.min(left, w * 0.3), right: Math.min(right, w * 0.35) };
  }
  function resize() {
    const ins = measureInsets();
    const { w, h } = ins;
    renderer.setSize(w, h, false);
    const offX = ins.right - ins.left, offY = ins.top - ins.bottom;
    const fullW = w + Math.abs(offX), fullH = h + Math.abs(offY);
    camera.aspect = fullW / fullH;
    camera.setViewOffset(fullW, fullH, offX > 0 ? offX : 0, offY > 0 ? 0 : -offY, w, h);
    camera.updateProjectionMatrix();
    fitName(); fitAnswer();
    Object.assign(layout, ins, { freeW: Math.max(1, w - ins.left - ins.right), freeH: Math.max(1, h - ins.top - ins.bottom), fullH });
  }
  window.addEventListener('resize', resize);
  window.addEventListener('resize', () => renderZoom());
  if (NAME && window.visualViewport) window.visualViewport.addEventListener('resize', resize);
  if (window.ResizeObserver) {
    let raf = 0;
    const ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { resize(); scrollRailToSelection(); }); });
    ['prompt', 'rail', 'viewCard', 'panel'].forEach(id => ro.observe($(id)));
    ro.observe(document.querySelector('.dock'));
  }

  /* ---------------- presentation ---------------- */
  // Hidden, like the spinning globe of the geography tools (S in Study; not in the key hints): the page is cleared and
  // the model turns slowly on its own, for showing it or filming it. Space stops and starts the turning, S or Esc
  // leaves (and L would put a name on every piece of the part being studied: off for now, see LABELS). It can still be dragged, zoomed and turned with Control.
  const present = { on: false, paused: false, labels: false, was: null, layer: null, rows: [] };
  const LABELS = false;   // the names (L) are switched off for now: Pranay doesn't like how they look yet (Nov 17, 2026). The code below is kept.
  function setPresent(on) {
    if (present.on === on) return;
    present.on = on; document.body.classList.toggle('present', on);
    if (on) {
      present.was = { clean: state.clean };
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();   // (Space must not press a button)
      setCallout(null); setGlow(new Set()); setHover(null);
      if (!state.clean) setClean(true);
      present.paused = false; controls.autoRotate = true; controls.autoRotateSpeed = 1.6;   // (a turn in about 40 s)
      // (the wheel zooms toward the middle of the view here, not toward the pointer: zooming toward the pointer moves
      // the point the camera turns about, and the model then swung round a spot beside it)
      controls.zoomToCursor = false;
    } else {
      controls.autoRotate = false; controls.zoomToCursor = true; setLabels(false);
      if (!present.was.clean) setClean(false);
      if (state.mode === 'study' && study) showStudyItem(false);
    }
  }
  // The names, drawn as a head-up display (for the look of it, like Project Knight's body scan, more than for reading):
  // two columns well clear of the model, each name with a bar at its inner end, and from it a trace of straight
  // pieces only: out level, up or down, then level to a ring on its piece. The traces of a column nest like brackets:
  // the rows furthest from its middle turn nearest the model, so they do not cross. A name's place never changes (the
  // names are in the order of their pieces from top to bottom, which a turn about the upright axis leaves alone, and
  // go to the two columns by turns); only the traces move as the model turns. A piece with a left and a right member
  // is pointed at on its column's side. One name after another lights up, down the list. Where there are more names
  // than rows (15 px a row), they are thinned evenly.
  const SVG = 'http://www.w3.org/2000/svg';
  function setLabels(on) {
    present.labels = on;
    if (!present.layer) {
      present.layer = document.createElement('div'); present.layer.className = 'labels'; present.layer.setAttribute('aria-hidden', 'true');
      document.body.appendChild(present.layer);
    }
    present.layer.hidden = !on;
    present.layer.replaceChildren(); present.rows = []; present.lit = null;
    if (!on || !study) return;
    const W = window.innerWidth, H = window.innerHeight, top = 64, room = H - top - 48;
    const height = (it) => { let y = 0, n = 0; for (const id of it.accept) { const r = bones.get(id); if (r) { y += r.anchor.y; n++; } } return n ? y / n : 0; };
    let items = study.items.map(it => ({ it, y: height(it) })).sort((a, b) => b.y - a.y);
    const fit = 2 * Math.max(2, Math.floor(room / 15));
    if (items.length > fit) items = items.filter((_, i) => Math.floor(i * fit / items.length) !== Math.floor((i - 1) * fit / items.length));
    const perCol = Math.ceil(items.length / 2), step = Math.min(26, room / Math.max(1, perCol)), mid = (perCol - 1) / 2;
    const gap = Math.min(7, 96 / Math.max(1, mid));   // (between one trace's upright and the next)
    const svg = document.createElementNS(SVG, 'svg'); present.layer.appendChild(svg);
    items.forEach(({ it }, i) => {
      const right = i % 2 === 1, row = Math.floor(i / 2);
      const x = Math.round(W * (right ? 0.72 : 0.28)), y = Math.round(top + (row + 0.5) * step) + 0.5;
      const el = document.createElement('span'); el.textContent = it.name; if (!right) el.className = 'left';
      el.style.left = x + 'px'; el.style.top = y + 'px'; el.style.transitionDelay = (row * 14) + 'ms'; present.layer.appendChild(el);
      const line = document.createElementNS(SVG, 'polyline'), ring = document.createElementNS(SVG, 'circle');
      ring.setAttribute('r', 3.5); line.style.transitionDelay = ring.style.transitionDelay = (row * 14 + 120) + 'ms'; svg.append(line, ring);
      const turn = Math.round(x + (right ? -1 : 1) * (18 + Math.abs(row - mid) * gap)) + 0.5;
      present.rows.push({ it, right, el, line, ring, parts: [el, line, ring], start: `${x},${y} ${turn},${y} ${turn},`, turn, shown: false });
    });
    setTimeout(() => { for (const r of present.rows) for (const e of r.parts) e.style.transitionDelay = ''; }, perCol * 14 + 600);   // (the delays were for coming in, a row at a time)
  }
  window.addEventListener('resize', () => { if (present.labels) setLabels(true); });
  function updateLabels(now) {
    for (const row of present.rows) {
      let best = null;
      for (const id of row.it.accept) {
        const r = bones.get(id); if (!r || !r.mesh.visible) continue;
        const p = projectPx(r.anchor); if (p.behind) continue;
        if (!best || (row.right ? p.x > best.x : p.x < best.x)) best = p;
      }
      const show = !!best && best.x > 0 && best.y > 0 && best.x < window.innerWidth && best.y < window.innerHeight;
      if (show) {
        const y = best.y.toFixed(1);
        row.line.setAttribute('points', `${row.start}${y} ${best.x.toFixed(1)},${y}`);
        row.ring.setAttribute('cx', best.x.toFixed(1)); row.ring.setAttribute('cy', y);
      }
      if (show !== row.shown) { row.shown = show; for (const e of row.parts) e.classList.toggle('in', show); }
    }
    const lit = present.rows[Math.floor(now / 240) % Math.max(1, present.rows.length)];
    if (lit !== present.lit) {
      if (present.lit) for (const e of present.lit.parts) e.classList.remove('lit');
      present.lit = lit; if (lit) for (const e of lit.parts) e.classList.add('lit');
    }
  }

  /* ---------------- render loop ---------------- */
  const tmpC = new THREE.Color();
  function updateCallout() {
    const box = $('callout'), line = $('leaderLine'), dot = $('leaderDot');
    const it = callout.item;
    const show = it && (state.mode === 'study' || !!review || (session && session.phase === 'reveal'));
    let rec = null;
    if (show) {
      if (callout.anchorId && it.accept.has(callout.anchorId)) rec = bones.get(callout.anchorId);
      else {   // point at whichever member is nearest the middle of the free area, preferring the side nearer the camera
        // (seen from the side, a left and right pair project onto the same spot: the far one would be behind the near one)
        const cx = layout.left + layout.freeW / 2, cy = layout.top + layout.freeH / 2;
        let bestD = Infinity, nearest = Infinity;
        for (const id of it.accept) { const r = bones.get(id); if (r) nearest = Math.min(nearest, r.center.distanceTo(camera.position)); }
        for (const id of it.accept) {
          const r = bones.get(id); if (!r) continue; const p = projectPx(r.anchor); if (p.behind) continue;
          const d = Math.hypot(p.x - cx, p.y - cy) + (settings.calloutNearSide === false ? 0 : 600 * (r.center.distanceTo(camera.position) / nearest - 1));
          if (d < bestD) { bestD = d; rec = r; }
        }
      }
    }
    callout.rec = rec;
    const p = rec ? projectPx(rec.anchor) : null;
    if (!p || p.behind) { box.hidden = true; line.setAttribute('x1', 0); line.setAttribute('x2', 0); line.setAttribute('y1', 0); line.setAttribute('y2', 0); dot.setAttribute('r', 0); return; }
    box.hidden = false;
    if (settings.calloutWraps) box.style.maxWidth = Math.max(140, Math.min(560, layout.freeW - 12)) + 'px';   // long names wrap within the free area
    const bw = box.offsetWidth, bh = box.offsetHeight;
    const cx = layout.left + layout.freeW / 2;
    const dir = p.x < cx ? -1 : 1;
    let lx = dir < 0 ? p.x - 56 - bw : p.x + 56;
    let ly = p.y - 46 - bh / 2;
    lx = Math.max(layout.left + 6, Math.min(lx, layout.w - layout.right - bw - 6));
    ly = Math.max(layout.top + 6, Math.min(ly, layout.h - layout.bottom - bh - 6));
    box.style.transform = `translate(${lx.toFixed(1)}px, ${ly.toFixed(1)}px)`;
    // the line meets the box's side; where a long label that wraps (settings.calloutWraps) had to sit right over the piece, its top or bottom edge
    let ex = dir < 0 ? lx + bw : lx, ey = ly + bh / 2;
    if (settings.calloutWraps && p.x > lx && p.x < lx + bw) { ex = p.x; ey = p.y > ly + bh / 2 ? ly + bh : ly; }
    line.setAttribute('x1', p.x.toFixed(1)); line.setAttribute('y1', p.y.toFixed(1));
    line.setAttribute('x2', ex.toFixed(1)); line.setAttribute('y2', ey.toFixed(1));
    dot.setAttribute('cx', p.x.toFixed(1)); dot.setAttribute('cy', p.y.toFixed(1)); dot.setAttribute('r', 3.5);
  }
  function sameSet(a, b) { if (a.size !== b.size) return false; for (const x of a) if (!b.has(x)) return false; return true; }
  // What is in front of the piece being shown is faded, so it is never buried (Study, a practice reveal, search): the
  // things on the lines of sight from the camera to its middle and to the point the callout lands on. That is worked
  // out once, when the piece is shown and the camera has reached its view, and then left alone: nothing fades in or out
  // while the model is turned, and no frame pays for the check. It is worked out again only when what is shown changes
  // (another piece, a zoom area, a layer, X-ray off: whatever clears occ.key).
  // And only when the piece needs it: lines of sight also go to points spread over the side of the piece that faces the
  // camera, and nothing is faded unless more than half of them are blocked (a ligament crossed by a rib or two is easy
  // enough to see as it is, and its glow shows through). settings.fadeWhenHidden: that share (1 = never fade).
  const FADE_WHEN_HIDDEN = settings.fadeWhenHidden ?? 0.5;
  const sightPoint = new THREE.Vector3(), sightDir = new THREE.Vector3();
  // (up to 24 of the piece's own points, evenly through its mesh, kept in the mesh's own space: a piece may move)
  function sightSamples(rec) {
    if (!rec.sight) {
      const pos = rec.mesh.geometry.attributes.position, n = Math.min(24, pos.count);
      rec.sight = Array.from({ length: n }, (_, i) => new THREE.Vector3().fromBufferAttribute(pos, Math.floor((i + 0.5) * pos.count / n)));
    }
    return rec.sight;
  }
  // what is on the line of sight to a point of the piece being shown, short of the point itself
  function inSightOf(point) {
    sightDir.copy(point).sub(camera.position); const dist = sightDir.length(); sightDir.normalize();
    raycaster.set(camera.position, sightDir); raycaster.near = 0; raycaster.far = Math.max(0, dist - 0.002);
    const hits = raycaster.intersectObjects(liveMeshes, false);
    raycaster.far = Infinity;
    return hits;
  }
  // Of the atlas's own pieces, only those lying over the one being shown (an outer layer) and much bigger ones around it
  // (the skull around the ear bones) count as in front; a similar neighbour at the same depth stays solid and the glow
  // shows through it. Anything of the frame counts.
  function inFrontOf(rec, hit) {
    const r = hit.object.userData.rec;
    return !r || (!callout.item.accept.has(r.id) && (r.data.layer < rec.data.layer || r.radius > rec.radius * 1.6));
  }
  // ...and never while the model is being dragged. The label of a left and right pair points at whichever is nearer
  // the camera, so it changes sides as the model is turned, and each change is another piece to work this out for: two
  // dozen lines of sight through the whole model, then bones turning see-through or solid. Mid-drag that was a stutter
  // at every change, with parts of the skull coming and going (the jaw joint's disc, the olfactory nerves: pairs near
  // the midline, in the densest part of the model). It now waits until the drag is let go.
  let turning = false;
  controls.addEventListener('start', () => { turning = true; });
  controls.addEventListener('end', () => { turning = false; });
  function updateOccluders() {
    if (turning) return;
    const rec = callout.rec;
    const moved = own.occKey ? own.occKey() : '';   // (pieces that move: where they are now, or null while they are moving)
    const key = rec && !state.xray && moved !== null ? (callout.item.key || '') + '|' + (callout.anchorId || rec.id) + '|' + moved : '';
    if (key === occ.key) return;
    const onTheWay = !!key && !!fly;   // the camera is flying to the piece's view: nothing is faded until it is there
    if (!onTheWay) occ.key = key;
    const recs = new Set(), ctx = new Set();
    if (key && !onTheWay) {
      let facing = 0, blocked = 0;
      for (const local of sightSamples(rec)) {
        const hits = inSightOf(sightPoint.copy(local).applyMatrix4(rec.mesh.matrixWorld));
        if (hits.some(h => h.object === rec.mesh)) continue;   // a point on the far side of the piece: hidden by the piece itself
        facing++;
        if (hits.some(h => inFrontOf(rec, h))) blocked++;
      }
      occ.hidden = facing ? blocked / facing : 0;   // (how much of the piece was hidden when it was shown)
      if (occ.hidden > FADE_WHEN_HIDDEN) {
        for (const pt of [rec.anchor, rec.center]) for (const h of inSightOf(pt)) {
          if (!inFrontOf(rec, h)) continue;
          if (h.object.userData.rec) recs.add(h.object.userData.rec); else ctx.add(h.object);
        }
      }
    }
    if (!sameSet(recs, occ.recs) || !sameSet(ctx, occ.ctx)) { occ.recs = recs; occ.ctx = ctx; applyVisibility(); }
  }
  function tick(now) {
    if (fly) {
      const k = Math.min(1, (now - fly.s) / fly.dur), e = fly.out ? 1 - (1 - k) * (1 - k) : k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      controls.target.lerpVectors(fly.t0, fly.t1, e);
      sphNow.set(fly.r0 + (fly.r1 - fly.r0) * e, fly.ph0 + (fly.ph1 - fly.ph0) * e, fly.th0 + fly.dth * e).makeSafe();
      camera.position.setFromSpherical(sphNow).add(controls.target);
      if (k >= 1) fly = null;
    }
    controls.update();
    own.tick?.(now);
    if (hoverPending && (present.on || (NAME && isolated()))) { hoverPending = null; setHover(null); }
    if (hoverPending && now >= hoverNext) {
      const t0 = performance.now(), p = pickAt(hoverPending.x, hoverPending.y);
      hoverPending = null; setHover(p && p.rec ? p.rec : null);
      hoverNext = now + 4 * (performance.now() - t0);
    }
    overlayMat.opacity = 0.28 + 0.3 * (0.5 + 0.5 * Math.sin(now / 220));
    for (const r of bones.values()) {
      // solid: the piece being shown glows in its own colour (lifted towards white if it is dark), the one pointed at more faintly
      if (SOLID && r.glow) { tmpC.set(pieceColor(r.data)); tmpC.lerp(WHITE, Math.max(0, 0.45 - lum(tmpC))).multiplyScalar(0.42); }
      else if (SOLID && hoverSet.has(r)) tmpC.set(pieceColor(r.data)).multiplyScalar(0.22);
      else if (r.tint) tmpC.copy(r.tint).multiplyScalar(0.1); else tmpC.setRGB(0, 0, 0);
      if (!SOLID && r === hoverRec) tmpC.copy(COL.scan).multiplyScalar(0.16);
      if (r.flash) {
        const k = (now - r.flash.t0) / r.flash.dur;
        if (k >= 1) r.flash = null; else tmpC.lerp(r.flash.color, 0.85 * (1 - k));
      }
      r.mat.emissive.copy(tmpC);
    }
    if (session && !session.end && state.mode !== 'study' && !pendingConfirm) $('sTime').textContent = fmtTime(now - session.start);
    camera.updateMatrixWorld();
    own.frame?.();
    updateCallout();
    if (present.on && present.labels) updateLabels(now);
    if (!SOLID) updateOccluders();
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }

  /* ---------------- boot ---------------- */
  lang.apply();
  // An atlas's own code starts here (settings.extend). It is handed what it may use of the engine and gives back the
  // functions the engine calls at the points marked `own.` above: see engine-atlas/machine.js.
  if (settings.extend) own = settings.extend({
    $, BONE, DATA, THREE, UNIT, VIEW_DIRS, ZOOMS, applyVisibility, bones, callout, camera, closeViewSheetOnPhone, controls, fitDistance, flyTo, frameSection, inScope, inSide, inView, layout, narrow, occ, onScreen, projectPx, renderPrompt, renderZoom, renderer, resize, scene, scopeSphere, setCallout, setGlow, setView, state, store, studyPick, t, toast, voiceStatus, zoomDir, zoomed,
    get pendingConfirm() { return pendingConfirm; }, get study() { return study; },
    get autoView() { return autoView; }, set autoView(v) { autoView = v; },
  });
  setLayer(1); if ($('bonesBtn')) setBonesShown(state.bones);
  renderSegs(); renderRail(); renderBest(); renderZoom(); own.ready?.(); resize();
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  async function fetchModel(url, onProgress) {
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const total = MODEL_BYTES || +res.headers.get('content-length') || 0;
    const chunks = []; let got = 0;
    if (res.body && res.body.getReader) {
      const reader = res.body.getReader();
      for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length; if (total) onProgress(Math.min(1, got / total)); }
    } else { chunks.push(new Uint8Array(await res.arrayBuffer())); }
    const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let o = 0; for (const c of chunks) { bytes.set(c, o); o += c.length; }
    if (!/\.txt$/.test(url)) return bytes.buffer;
    const bin = atob(new TextDecoder().decode(bytes).trim());
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }
  function onModel(gltf) {
    const root = gltf.scene;
    scene.add(root);
    root.updateMatrixWorld(true);
    const pickMeshes = new Map();   // pk_<id>: the fatter, invisible tube a click lands on
    const meshes = [];   // listed first: making a piece's record may move it in the tree
    root.traverse((o) => { if (o.isMesh) meshes.push(o); });
    for (const o of meshes) {
      const id = o.name;
      if (id.startsWith('pk_')) { pickMeshes.set(id, o); o.visible = false; }
      else if (BONE[id]) bones.set(id, boneRecord(o, BONE[id]));
      else if (DATA.context && DATA.context[id]) {
        const c = DATA.context[id];   // kind, side, extra (the piece's name), subs and regions (the areas it is part of the frame for)
        o.material = ctxMats[c.kind].clone(); o.userData.ctx = { id, kind: c.kind, extra: c.extra };
        // ghosts draw first, so pieces behind them still show through (settings.frameDrawnFirst: false = not; a kind can set its own order)
        const how = settings.context[c.kind];
        if (how.order != null) o.renderOrder = how.order; else if (settings.frameDrawnFirst !== false) o.renderOrder = -1;
        if (how.outlined) outline(o, how.outlined === 'edges');
        if (how.rays === false) o.raycast = () => {};
        ctxPieces.push({ id, mesh: o, kind: c.kind, subs: c.subs, regions: c.regions, side: c.side, baseOpacity: ctxMats[c.kind].opacity });
      } else o.visible = false;
    }
    for (const r of bones.values()) {
      const pk = r.data.pick && pickMeshes.get(r.data.pick);
      if (!pk) continue;
      r.pick = pk; pk.userData.rec = r; pk.visible = false;
      // the glow uses the fat tube too, so a thin piece lights up as a band you can see
      r.mesh.remove(r.overlay);
      r.overlay = new THREE.Mesh(pk.geometry, overlayMat); r.overlay.visible = false; r.overlay.renderOrder = 10; r.overlay.raycast = () => {};
      if (!(own.pick && own.pick(r, pk))) { pk.updateMatrixWorld(true); r.overlay.applyMatrix4(pk.matrixWorld); scene.add(r.overlay); }
    }
    const missing = DATA.bones.filter(b => !bones.has(b.id)).map(b => b.id);
    if (missing.length) console.warn('Pieces missing from model:', missing);
    modelBox = new THREE.Box3().setFromObject(root);
    own.model?.(root);
    if (settings.floor === 'fitted') placePlatform(modelBox);
    window.__atlas = { bones: bones.size, missing, context: ctxPieces.length };
    if (location.hash === '#selftest') {
      window.__atlas.t = { THREE, bones, state, camera, controls, pickAt, applyVisibility, setSection, setXray, setMode, startSession,
        frameSection, getSession: () => session, getStudy: () => study, setHints, setView, zoomKey, studyStep, renderPrompt, cancelFly, buildItems, countFor, layout,
        ctxPieces, CONTEXT_CLICKABLE, projectPx, parseVoice, setVoice, voice, standardView, areaFor, setLayer, setBonesShown, UNIT, DATA, contextNote, showBones, clearAutoView: () => { autoView = ''; }, callout, occ, studyPick, scopeSphere,
        setLang: lang.set, ...(settings.bodies ? { setSex } : {}), i18n: () => ({ LANG: lang.code, t, label, viewLabel, sectionLabel }), renderSearch, hideBone: (id) => hideBone(bones.get(id)), answer, finishSession: () => finishSession(),
        ...own.handles,
        flyNow: () => { own.flyNow?.(); if (!fly) { if (own.flyNow) { controls.update(); camera.updateMatrixWorld(); } return; } controls.target.copy(fly.t1); sphNow.set(fly.r1, fly.ph1, fly.th0 + fly.dth).makeSafe(); camera.position.setFromSpherical(sphNow).add(controls.target); fly = null; controls.update(); camera.updateMatrixWorld(); } };
    }
    applyVisibility();
    resize();
    const s = own.scopeSphere ? scopeSphere('all') : modelBox.getBoundingSphere(new THREE.Sphere());
    if (STAGE.maxZoomOut) controls.maxDistance = fitDistance(s.radius) * STAGE.maxZoomOut;
    controls.target.copy(s.center);
    camera.position.copy(s.center).add(VIEW_DIRS[STAGE.startView || settings.defaultView || 'front'].clone().normalize().multiplyScalar(fitDistance(s.radius)));
    frameSection();
    if (STAGE.startInPlace && fly) { controls.target.copy(fly.t1); sphNow.set(fly.r1, fly.ph1, fly.th0 + fly.dth).makeSafe(); camera.position.setFromSpherical(sphNow).add(controls.target); fly = null; }
    $('loading').hidden = true;
    startSession();
  }
  function onModelError(err) {
    console.error(err);
    $('loadMsg').textContent = SiteLanguage.bootText('model_fail');
  }
  fetchModel(MODEL_URL, (f) => { $('loadBar').value = f; })
    .then((buf) => loader.parse(buf, '', onModel, onModelError))
    .catch(onModelError);
  requestAnimationFrame(tick);
}

document.addEventListener("DOMContentLoaded", () => {
  const w = document.createElement("div");
  w.style.cssText = "position:fixed;bottom:15px;right:15px;background:#0f172a;color:#fff;padding:6px 14px;border-radius:8px;font-size:13px;z-index:9999;font-weight:bold;box-shadow:0 4px 12px rgba(0,0,0,0.3);pointer-events:none;";
  w.innerHTML = "⚡ Created by Dr. Helix";
  document.body.appendChild(w);
});
