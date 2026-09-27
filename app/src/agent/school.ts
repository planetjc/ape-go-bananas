// The School view: the same library as Decks, seen as a student's year.
// Semesters are sections -- the one under way first, those ahead after it,
// past ones folded -- and each class in one is a card with its next exam.
// A class opens to its own screen (class-steps.ts, class-pane.ts), where
// its syllabus, exams and decks are. Decks outside any class are not shown
// here; they are what the Decks view is for.
//
// Nothing here is a second tree: a semester and a class are folders, Anki's
// `::` paths, and the records that make them one live in the engine
// (course.ts). What this view adds is the order and the words.

import type { ClassSummary, DeckSummary, Semester } from '../engine/client.js';
import { canBeClass, countdown, defaultSemester, nextExam, nextTerm, orderSemesters, semesterOf, shortDate, termFromName, termRange, termState, upcomingExams } from './class-rules.js';
import { splitName } from './deck-list.js';
import { mountNotice } from './notice.js';

/** A class to make: named new, or a folder the person has already, in a semester or none. */
export interface NewClass {
  name: string | null;
  fromFolder: string | null;
  semester: string | null;
  newSemester: { folder: string; start: string | null; end: string | null } | null;
}

export interface SchoolOptions {
  /** Where the semesters and classes are listed as places to go. */
  rail?: HTMLElement;
  onOpenClass(cls: ClassSummary): void;
  /** Resolves true when it was made; the view is refreshed by the caller. */
  onNewClass(spec: NewClass): Promise<boolean>;
  onMakeSemester(folder: string, start: string | null, end: string | null): Promise<boolean>;
  onSemesterDates(folder: string, start: string | null, end: string | null): Promise<boolean>;
  /** Back to a plain folder; its classes stay. */
  onUnsemester(folder: string): Promise<void>;
  /** Renames a semester's folder, and so every class and deck in it. */
  onRenameFolder(from: string, to: string): Promise<void>;
  /** An empty semester; its classes go to the trash with it. */
  onDeleteFolder(name: string): Promise<void>;
  /** Over to the Decks view. */
  showDecks(): void;
}

export interface School {
  set(decks: DeckSummary[], folders: string[], classes: ClassSummary[], semesters: Semester[]): void;
  /** The class still open behind the view, marked in the rail; null when none is. */
  setOpen(path: string | null): void;
  notify(text: string, action?: { label: string; run(): void }): void;
  /** Opens the new-class form, in `semester` when given. */
  newClass(semester?: string): void;
}

// Past semesters start folded and the rest open; what the person turned the other way is kept.
const FLIPPED = 'ape.school.flipped';

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

const inFolder = (name: string, folder: string): boolean => name === folder || name.startsWith(`${folder}::`);

export function mountSchool(host: HTMLElement, opts: SchoolOptions): School {
  host.innerHTML = `
    <div class="school">
      <header class="school-head"><h2>School</h2><span class="grow"></span><button type="button" class="quiet" id="s-newterm">New semester</button><button type="button" id="s-newclass">New class</button></header>
      <div id="s-notice"></div>
      <div id="s-form"></div>
      <div id="s-body"></div>
    </div>`;
  const $ = <T extends HTMLElement>(sel: string): T => host.querySelector<T>(sel)!;
  const notice = mountNotice($<HTMLElement>('#s-notice'));
  const formEl = $<HTMLElement>('#s-form');
  const body = $<HTMLElement>('#s-body');
  let decks: DeckSummary[] = [];
  let folders: string[] = [];
  let classes: ClassSummary[] = [];
  let semesters: Semester[] = [];
  let openPath: string | null = null;
  /** The form above the list: a new class (in a semester, when given), a new semester, or none. */
  let form: { kind: 'class'; semester?: string } | { kind: 'term' } | null = null;
  /** A semester's header being edited in place: its dates, or its name. */
  let editing: { folder: string; what: 'dates' | 'rename' } | null = null;
  let flipped = new Set<string>();
  try {
    flipped = new Set(JSON.parse(localStorage.getItem(FLIPPED) ?? '[]') as string[]);
  } catch {
    /* storage blocked or unreadable: the defaults */
  }
  const folded = (t: Semester): boolean => (termState(t) === 'past') !== flipped.has(t.folder);

  // ---- the list ---------------------------------------------------------------------
  const classesIn = (folder: string | null): ClassSummary[] =>
    classes
      .filter((c) => (folder === null ? !semesterOf(c.folder, semesters) : c.folder.startsWith(`${folder}::`)))
      .sort((a, b) => a.folder.localeCompare(b.folder, undefined, { numeric: true, sensitivity: 'base' }));
  const decksOf = (cls: ClassSummary): number => decks.filter((d) => inFolder(d.name, cls.folder)).length;

  /** A class as a card: its name, what is next for it, and how far along its brief is. */
  function card(cls: ClassSummary, within: string | null): string {
    const next = nextExam(cls.exams);
    const n = decksOf(cls);
    const fresh = cls.newPapers?.length ?? 0;
    const brief = fresh ? `${fresh} new doc${fresh === 1 ? '' : 's'} for the brief` : cls.brief === 'reviewed' ? 'brief read' : cls.brief === 'written' ? 'brief to read' : cls.files ? 'brief not written' : 'add the syllabus';
    const name = within ? cls.folder.slice(within.length + 2) : cls.folder;
    return `<button type="button" class="ccard${cls.path === openPath ? ' open' : ''}" data-open-class="${esc(cls.path)}" title="${esc(cls.folder)}">
      <span class="ccard-name">${esc(name)}</span>
      <span class="ccard-exam${next ? '' : ' none'}">${next ? `${esc(next.name)} · ${esc(countdown(next.date!))}` : cls.exams.length ? 'no exam ahead' : 'no exams yet'}</span>
      <span class="ccard-meta">${n} deck${n === 1 ? '' : 's'} · ${esc(brief)}</span>
    </button>`;
  }

  function termHead(t: Semester, open: boolean, count: number): string {
    const state = termState(t);
    const f = esc(t.folder);
    if (editing?.folder === t.folder && editing.what === 'rename')
      return `<form class="dedit sedit" data-form="rename" data-folder="${f}"><input name="to" value="${f}" aria-label="Semester name" autocomplete="off" spellcheck="false"><button type="submit">Save</button><button type="button" class="quiet" data-cancel>Cancel</button><p class="hint">Renames the folder, and every class and deck in it — in Anki too, once they are sent again.</p></form>`;
    const empty = count === 0 && !decks.some((d) => inFolder(d.name, t.folder));
    return `<header class="term-head">
      <button type="button" class="term-fold" aria-expanded="${open}" data-fold="${f}"><span class="dchev" aria-hidden="true"></span><strong>${esc(t.folder)}</strong></button>
      <span class="dterm-range">${esc(termRange(t))}</span>${state === 'now' ? '<span class="dnow">now</span>' : state === 'ahead' && t.start ? `<span class="term-when">starts ${esc(countdown(t.start))}</span>` : state === 'past' ? '<span class="term-when">past</span>' : ''}
      <span class="grow"></span>
      <span class="term-acts"><button type="button" class="quiet" data-dates="${f}">Dates</button><button type="button" class="quiet" data-rename="${f}">Rename</button>${empty ? `<button type="button" class="quiet danger" data-delete="${f}">Delete</button>` : ''}</span>
    </header>
    ${editing?.folder === t.folder && editing.what === 'dates' ? datesForm(t) : ''}`;
  }

  function datesForm(t: Semester): string {
    return `<form class="dedit sedit" data-form="dates" data-folder="${esc(t.folder)}">
      <span>Dates</span><input type="date" name="start" value="${esc(t.start ?? '')}" aria-label="First day"><span aria-hidden="true">–</span><input type="date" name="end" value="${esc(t.end ?? '')}" aria-label="Last day">
      <button type="submit">Save</button><button type="button" class="quiet" data-cancel>Cancel</button>
      <p class="hint">The dates say which semester is now. <button type="button" class="link" data-unsemester="${esc(t.folder)}">Make it a plain folder</button> — its classes stay, with no semester.</p></form>`;
  }

  function coming(list: ClassSummary[], within: string): string {
    const up = upcomingExams(list, new Date(), 5);
    if (!up.length) return '';
    return `<div class="coming"><div class="railhead">Coming up</div><ul class="hexams">${up
      .map(({ exam, cls }) => `<li><span class="hx-date">${esc(shortDate(exam.date!))}</span><strong>${esc(exam.name)}</strong><button type="button" class="link hx-class" data-open-class="${esc(cls.path)}">${esc(cls.folder.slice(within.length + 2))}</button><span class="hx-when">${esc(countdown(exam.date!))}</span></li>`)
      .join('')}</ul></div>`;
  }

  function section(t: Semester): string {
    const list = classesIn(t.folder);
    const open = !folded(t);
    const state = termState(t);
    return `<section class="term ${state}">${termHead(t, open, list.length)}${
      open
        ? `${state === 'past' ? '' : coming(list, t.folder)}<div class="ccards">${list.map((c) => card(c, t.folder)).join('')}<button type="button" class="ccard add" data-new-class="${esc(t.folder)}"><span class="ccard-name">+ New class</span><span class="ccard-meta">in ${esc(splitName(t.folder).leaf)}</span></button></div>`
        : ''
    }</section>`;
  }

  function render(): void {
    renderForm();
    renderRail();
    const loose = classesIn(null);
    const outside = decks.filter((d) => !classes.some((c) => inFolder(d.name, c.folder))).length;
    if (!semesters.length && !classes.length) {
      body.innerHTML = `<div class="school-empty">
        <p><strong>School keeps a class together:</strong> its syllabus, its exam dates, and its decks.</p>
        <ul>
          <li>Drop the syllabus on a class once. The agent reads it into a brief that every deck in the class is given — what is off the exam, how the exams are set, the course's terms.</li>
          <li>Exam dates come from the syllabus for you to check. Each deck is sized to what you can review before its exam, at your own new cards a day.</li>
          <li>Classes sit in semesters, and the one under way comes first, with what is coming up.</li>
        </ul>
        <p><button type="button" data-first-class>Make your first class</button></p>
        ${outside ? `<p class="muted">Your ${outside} deck${outside === 1 ? ' is' : 's are'} in <button type="button" class="link" data-decks>Decks</button>, as before.</p>` : ''}
      </div>`;
      return;
    }
    body.innerHTML =
      orderSemesters(semesters).map(section).join('') +
      (loose.length ? `<section class="term loose"><header class="term-head"><strong class="term-plain">No semester</strong><span class="term-when">classes not in a semester — move one from its screen</span></header><div class="ccards">${loose.map((c) => card(c, null)).join('')}</div></section>` : '') +
      (outside ? `<p class="muted school-foot">${outside} deck${outside === 1 ? ' is' : 's are'} not in a class — they are in <button type="button" class="link" data-decks>Decks</button>.</p>` : '');
    const input = body.querySelector<HTMLInputElement>('.sedit input');
    if (input && document.activeElement !== input) input.focus();
  }

  /** The form above the list. A new class names its semester -- the one under way, unless the person picks another, or a new one. */
  function renderForm(): void {
    if (!form) {
      formEl.innerHTML = '';
      return;
    }
    const guess = nextTerm(semesters);
    if (form.kind === 'term') {
      formEl.innerHTML = `<form class="panel sform" data-form="term">
        <h3>New semester</h3>
        <div class="srow"><input name="name" data-term-name value="${esc(guess.name)}" aria-label="Semester name" autocomplete="off" spellcheck="false">
          <input type="date" name="start" data-auto value="${esc(guess.start)}" aria-label="First day"><span aria-hidden="true">–</span><input type="date" name="end" data-auto value="${esc(guess.end)}" aria-label="Last day"></div>
        <p class="hint">The dates say which semester is now, so it is listed first and new classes go in it.</p>
        <div class="srow"><button type="submit">Make semester</button><button type="button" class="quiet" data-cancel>Cancel</button></div></form>`;
    } else {
      const pick = form.semester ?? defaultSemester(semesters)?.folder ?? '__new';
      const label = (t: Semester) => `${t.folder}${termState(t) === 'now' ? ' · now' : termState(t) === 'past' ? ' · past' : ''}`;
      // A folder already full of decks for this course can become the class, rather than starting over.
      const from = folders.filter((f) => canBeClass(f, classes, semesters) && decks.some((d) => inFolder(d.name, f)));
      formEl.innerHTML = `<form class="panel sform" data-form="class">
        <h3>New class</h3>
        <div class="srow"><input name="name" placeholder="Class name — Histology" aria-label="Class name" autocomplete="off" spellcheck="false">
          <label class="dterm-pick">in <select name="term" aria-label="Semester">
            ${orderSemesters(semesters).map((t) => `<option value="${esc(t.folder)}"${t.folder === pick ? ' selected' : ''}>${esc(label(t))}</option>`).join('')}
            <option value="__new"${pick === '__new' ? ' selected' : ''}>New semester…</option>
            <option value="">No semester</option>
          </select></label></div>
        <div class="srow dterm-new"${pick === '__new' ? '' : ' hidden'}><input name="termName" data-term-name value="${esc(guess.name)}" aria-label="New semester's name" autocomplete="off" spellcheck="false"><input type="date" name="start" data-auto value="${esc(guess.start)}" aria-label="First day"><span aria-hidden="true">–</span><input type="date" name="end" data-auto value="${esc(guess.end)}" aria-label="Last day"></div>
        ${from.length ? `<div class="srow"><label class="dterm-pick">or make a folder you have a class: <select name="from" aria-label="A folder to make a class"><option value="">—</option>${from.map((f) => `<option value="${esc(f)}">${esc(f)} (${decks.filter((d) => inFolder(d.name, f)).length} decks)</option>`).join('')}</select></label></div>` : ''}
        <p class="hint">Next, drop its syllabus on it: the agent reads it into a brief every deck in the class is given, and finds the exam dates.</p>
        <div class="srow"><button type="submit">Make class</button><button type="button" class="quiet" data-cancel>Cancel</button></div></form>`;
    }
    formEl.querySelector<HTMLInputElement>('input[name=name]')?.focus();
  }

  /** The rail beside it: each semester under way or ahead, and its classes, as places to go. */
  function renderRail(): void {
    const rail = opts.rail;
    if (!rail) return;
    const rows: string[] = [];
    for (const t of orderSemesters(semesters)) {
      if (termState(t) === 'past') continue;
      rows.push(`<li class="lterm"><span class="lname">${esc(splitName(t.folder).leaf)}</span>${termState(t) === 'now' ? '<span class="lmark lnow">now</span>' : ''}</li>`);
      for (const c of classesIn(t.folder)) rows.push(`<li><button type="button" data-open-class="${esc(c.path)}" class="${c.path === openPath ? 'on' : ''}" style="--depth:1" title="${esc(c.folder)}"><span class="lname">${esc(c.folder.slice(t.folder.length + 2))}</span></button></li>`);
    }
    for (const c of classesIn(null)) rows.push(`<li><button type="button" data-open-class="${esc(c.path)}" class="${c.path === openPath ? 'on' : ''}" title="${esc(c.folder)}"><span class="lname">${esc(c.folder)}</span></button></li>`);
    rail.innerHTML = `<div class="railhead">Classes</div><ul class="lib">${rows.join('') || '<li class="lterm"><span class="lname muted">None yet</span></li>'}</ul><button type="button" class="lnewfolder" data-rail-new-class>+ New class</button>`;
  }

  // ---- what the person does -----------------------------------------------------------
  const openClassAt = (t: HTMLElement): boolean => {
    const b = t.closest<HTMLElement>('[data-open-class]');
    const cls = b && classes.find((c) => c.path === b.dataset.openClass);
    if (cls) opts.onOpenClass(cls);
    return !!b;
  };

  $<HTMLButtonElement>('#s-newclass').addEventListener('click', () => {
    form = { kind: 'class' };
    render();
  });
  $<HTMLButtonElement>('#s-newterm').addEventListener('click', () => {
    form = { kind: 'term' };
    render();
  });
  opts.rail?.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (openClassAt(t)) return;
    if (t.closest('[data-rail-new-class]')) {
      form = { kind: 'class' };
      render();
    }
  });

  host.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (openClassAt(t)) return;
    if (t.closest('[data-decks]')) return opts.showDecks();
    if (t.closest('[data-first-class]')) {
      form = { kind: 'class' };
      return render();
    }
    if (t.closest('[data-cancel]')) {
      if (t.closest('#s-form')) form = null;
      else editing = null;
      return render();
    }
    const inTerm = t.closest<HTMLElement>('[data-new-class]');
    if (inTerm) {
      form = { kind: 'class', semester: inTerm.dataset.newClass! };
      render();
      host.closest<HTMLElement>('.view, main, .main')?.scrollTo({ top: 0 });
      return;
    }
    const fold = t.closest<HTMLElement>('[data-fold]');
    if (fold) {
      const f = fold.dataset.fold!;
      if (flipped.has(f)) flipped.delete(f);
      else flipped.add(f);
      try {
        localStorage.setItem(FLIPPED, JSON.stringify([...flipped]));
      } catch {
        /* storage blocked: folds reset next time */
      }
      return render();
    }
    const dates = t.closest<HTMLElement>('[data-dates]');
    if (dates) {
      editing = { folder: dates.dataset.dates!, what: 'dates' };
      return render();
    }
    const rename = t.closest<HTMLElement>('[data-rename]');
    if (rename) {
      editing = { folder: rename.dataset.rename!, what: 'rename' };
      return render();
    }
    const del = t.closest<HTMLElement>('[data-delete]');
    if (del) return void opts.onDeleteFolder(del.dataset.delete!);
    const plain = t.closest<HTMLElement>('[data-unsemester]');
    if (plain) {
      editing = null;
      render();
      void opts.onUnsemester(plain.dataset.unsemester!);
    }
  });

  host.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || (!form && !editing)) return;
    if ((e.target as HTMLElement).closest('#s-form')) form = null;
    else editing = null;
    render();
  });

  // A new semester's dates follow its name -- "Spring 2027" -- until the person sets them.
  host.addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement;
    const f = t.closest('form');
    if (!f) return;
    if (t.type === 'date') return void t.removeAttribute('data-auto');
    if (!t.hasAttribute('data-term-name')) return;
    const d = termFromName(t.value);
    const start = f.querySelector<HTMLInputElement>('[name=start][data-auto]');
    const end = f.querySelector<HTMLInputElement>('[name=end][data-auto]');
    if (start) start.value = d.start;
    if (end) end.value = d.end;
  });
  host.addEventListener('change', (e) => {
    const t = e.target as HTMLElement;
    const select = t.closest<HTMLSelectElement>('select[name=term]');
    const extra = select?.closest('form')?.querySelector<HTMLElement>('.dterm-new');
    if (select && extra) extra.hidden = select.value !== '__new';
    // A folder picked to become the class names it; there is nothing to type.
    const fromSel = t.closest<HTMLSelectElement>('select[name=from]');
    const name = fromSel?.closest('form')?.querySelector<HTMLInputElement>('input[name=name]');
    if (fromSel && name) {
      name.disabled = !!fromSel.value;
      if (fromSel.value) name.value = splitName(fromSel.value).leaf;
    }
  });

  host.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target as HTMLFormElement;
    const field = (n: string): string => f.querySelector<HTMLInputElement | HTMLSelectElement>(`[name=${n}]`)?.value.trim() ?? '';
    const kind = f.dataset.form;
    // Which form it was is read now: by the time the engine answers, the
    // refresh it brings has drawn the list again and this form is gone.
    const top = !!f.closest('#s-form');
    const back = (ok: boolean): void => {
      if (ok) {
        if (top) form = null;
        else editing = null;
      }
      render();
    };
    if (kind === 'term') {
      if (!field('name')) return;
      void opts.onMakeSemester(field('name'), field('start') || null, field('end') || null).then(back);
    } else if (kind === 'class') {
      const fromFolder = field('from') || null;
      const name = fromFolder ? null : field('name');
      if (!fromFolder && !name) return f.querySelector<HTMLInputElement>('input[name=name]')?.focus();
      const term = field('term');
      const spec: NewClass =
        term === '__new'
          ? { name, fromFolder, semester: field('termName'), newSemester: { folder: field('termName'), start: field('start') || null, end: field('end') || null } }
          : { name, fromFolder, semester: term || null, newSemester: null };
      if (term === '__new' && !field('termName')) return f.querySelector<HTMLInputElement>('input[name=termName]')?.focus();
      void opts.onNewClass(spec).then(back);
    } else if (kind === 'dates') {
      void opts.onSemesterDates(f.dataset.folder!, field('start') || null, field('end') || null).then(back);
    } else if (kind === 'rename') {
      const to = field('to');
      const from = f.dataset.folder!;
      editing = null;
      render();
      if (to && to !== from) void opts.onRenameFolder(from, to);
    }
  });

  return {
    set(d, f, c, t) {
      decks = d;
      folders = f;
      classes = c;
      semesters = t;
      if (editing && !semesters.some((x) => x.folder === editing!.folder)) editing = null;
      // Not while the person is typing in the form: a refresh landing would clear it.
      if (host.contains(document.activeElement) && document.activeElement?.closest('form')) {
        renderRail();
        return;
      }
      render();
    },
    setOpen(path) {
      openPath = path;
      renderRail();
      for (const b of body.querySelectorAll<HTMLElement>('.ccard[data-open-class]')) b.classList.toggle('open', b.dataset.openClass === path);
    },
    notify: (text, action) => notice.show(text, action),
    newClass(semester) {
      form = { kind: 'class', ...(semester ? { semester } : {}) };
      render();
    },
  };
}
