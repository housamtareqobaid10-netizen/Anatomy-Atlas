// Typed answers, for the atlases' "Name it" questions: what counts as the right name, and the hints.
// No page code here: atlas.js calls these with the names from an atlas's data (tests/unit/atlas-engine/).
//
// What counts: the anatomical name, or the everyday one where it is that thing's alone ("Latissimus dorsi" or "lats";
// not "quads", which is four muscles), in any case, with or without spaces, hyphens, commas and accents; and a near
// miss in the spelling ("gastrocnemeus"), unless what was typed is as close to the name of something else in the
// atlas ("pectoralis manor": major or minor?).

const plain = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// "Biceps brachii, long head" -> "bicepsbrachiilonghead" (fold: the page's own accent and case folding, /js/language.js)
// A # is kept: it says which numbering a tooth number is in (#6 is Universal, 16 is FDI)
export function squash(s, fold = plain) { return fold(s).replace(/[^\p{L}\p{N}#]+/gu, ''); }

// The ways of writing an item's anatomical name, from its two names: [with its hint, anatomical].
// "Latissimus dorsi (lats)" + "Latissimus dorsi" -> the anatomical name, and the two together.
// Brackets that are part of the anatomical name itself say which one is meant ("Flexor digiti minimi brevis (hand)"):
// the name counts with or without them. sides: words that only say which side ("right", "left"): with them, the name
// also counts without its side ("femur" for the right femur; "left femur" stays wrong).
export function forms([withHint, tech], fold = plain, sides = []) {
	const out = new Set([squash(tech, fold), squash(withHint, fold)]);
	const which = tech.match(/^(.*\S)\s*\([^)]*\)$/);
	if (which) out.add(squash(which[1], fold));
	const b = bare(tech, fold, sides);
	if (b) out.add(b);
	out.delete('');
	return [...out];
}
// the anatomical name without its side ('' when it has none, or no sides are given)
export function bare(tech, fold = plain, sides = []) {
	if (!sides.length) return '';
	const words = fold(tech).split(/[^\p{L}\p{N}]+/u).filter(Boolean), kept = words.filter((w) => !sides.includes(w));
	return kept.length && kept.length < words.length ? kept.join('') : '';
}
// ...and its everyday names, the hint in brackets after the anatomical one: "lats"; "(UCL, Tommy John ligament)" is
// two, "UCL" and "Tommy John ligament" ([] if it has none). A leading "the" is left off ("the wrist pulse").
export function everyday([withHint, tech], fold = plain) {
	if (withHint === tech || !withHint.startsWith(tech + ' (') || !withHint.endsWith(')')) return [];
	const parts = withHint.slice(tech.length + 2, -1).split(/[,;:·]|\s+or\s+/);
	return [...new Set(parts.map((p) => squash(p.trim().replace(/^(the|a|an)\s+/i, ''), fold)).filter(Boolean))];
}

// What counts as the name of one item, among all the atlas's items (each { names: its [with hint, anatomical] names,
// one pair per language it counts in (the language in use, and English), members: the pieces it is made of }):
// -> { answers: the ways of writing it that count, others: every way of writing anything else's name, vague: its
// everyday names that other things share, which are then no answer }.
// A part of the item itself is not something else: "biceps" names the whole biceps brachii, though each head is
// also "biceps"; asked for one head, "biceps" is vague. With sides, an item's mirror twin (the left femur, for the
// right) is something else by its full name only: "femur" and "thighbone" count for either.
// filler: words the name also counts without ("thyroid" for the thyroid gland), unless that leaves another's name
// too ("radial" for the radial artery, with "artery" and "vein" as filler: the radial vein too), and that may be added
// ("the deltoid muscle", in judge).
export function answersFor(item, all, { fold = plain, sides = [], filler = [] } = {}) {
	const mine = new Set(item.members), others = new Set();
	const pairs = (o) => (typeof o.names[0] === 'string' ? [o.names] : o.names);
	const myBare = new Set(pairs(item).map(([, tech]) => bare(tech, fold, sides)).filter(Boolean));
	for (const o of all) {
		if (o === item || o.members.every((id) => mine.has(id))) continue;
		for (const pair of pairs(o)) {
			// (a twin: the same name with the other side, or with no side: the left femur, or "Femur", both sides at once)
			const twin = myBare.size && (myBare.has(bare(pair[1], fold, sides)) || myBare.has(squash(pair[1], fold)));
			for (const f of forms(pair, fold, twin ? [] : sides)) others.add(f);
			const short = bare(pair[1], fold, filler);
			if (short) others.add(short);
			if (!twin) for (const e of everyday(pair, fold)) others.add(e);
		}
	}
	const answers = [...new Set(pairs(item).flatMap((pair) => forms(pair, fold, sides)))], vague = [];
	const shorts = pairs(item).map(([, tech]) => bare(tech, fold, filler)).filter(Boolean);
	for (const e of new Set([...shorts, ...pairs(item).flatMap((pair) => everyday(pair, fold))])) {
		if (answers.includes(e)) continue;
		if (others.has(e)) vague.push(e); else answers.push(e);
	}
	for (const a of answers) others.delete(a);   // (the hand's lumbricals and the foot's are both "lumbricals": the picture shows which)
	return { answers, others, vague };
}

// How many letters may be wrong, missing, extra or swapped with the next: none in a short name, up to three in a long one
export function slack(len) { return len < 5 ? 0 : len < 9 ? 1 : len < 15 ? 2 : 3; }

// The number of single-letter slips between two texts (a letter wrong, missing or extra, or two neighbours swapped);
// anything over `max` comes back as max + 1
export function slips(a, b, max = Infinity) {
	if (Math.abs(a.length - b.length) > max) return max + 1;
	let before = null, prev = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const row = [i];
		let least = i;
		for (let j = 1; j <= b.length; j++) {
			let d = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
			if (before && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, before[j - 2] + 1);
			row.push(d);
			if (d < least) least = d;
		}
		if (least > max) return max + 1;
		before = prev; prev = row;
	}
	return Math.min(prev[b.length], max + 1);
}

// Is what was typed the name? answers, others, vague: from answersFor; filler: words that may be left on ("deltoid
// muscle"). -> { ok, exact } (exact: false = a near miss in the spelling), or { ok: false } with empty when nothing was
// typed, vague when it is an everyday name several things share, other when it is the name of something else.
export function judge(typed, { answers, others, vague = [] }, { fold = plain, filler = [] } = {}) {
	const whole = squash(typed, fold);
	if (!whole) return { ok: false, empty: true };
	const tries = [whole];
	const words = fold(typed).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
	const kept = words.filter((w) => !filler.includes(w));
	if (kept.length && kept.length < words.length) tries.push(kept.join(''));
	for (const text of tries) if (answers.includes(text)) return { ok: true, exact: true };
	if (tries.some((text) => vague.includes(text))) return { ok: false, vague: true };
	if (others.has(whole)) return { ok: false, other: true };
	for (const text of tries) {
		let best = Infinity;
		for (const a of answers) { const d = slips(text, a, slack(a.length)); if (d <= slack(a.length) && d < best) best = d; }
		if (best === Infinity) continue;
		let clash = false;
		for (const o of others) if (slips(text, o, best) <= best) { clash = true; break; }
		if (!clash) return { ok: true, exact: false };
	}
	return { ok: false };
}

// The hints, one step at a time: 1 = how long the name is, 2 = its first letter as well (of the name, not of each
// word), 3 = the name.
// -> one entry per character: { ch, blank: a letter to be typed, shown: whether the hint gives it away }.
// Spaces, commas, hyphens and brackets are always shown: they aren't letters to recall.
export const HINTS = 3;
export function hintSlots(name, level) {
	let first = true;
	return [...name].map((ch) => {
		const letter = /[\p{L}\p{N}]/u.test(ch);
		const slot = { ch, blank: letter, shown: !letter || level >= HINTS || (level >= 2 && first) };
		if (letter) first = false;
		return slot;
	});
}
