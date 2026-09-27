// What a class shows above its files: its exams, which the person keeps --
// the agent proposes them from the syllabus, the person corrects them, and
// the organize step sizes each deck to the one it is studied for. On a deck
// in a class, the same place says which class, and which exam the deck is
// for, and lets that be changed.

import { EngineError, type ClassSummary, type CourseClass, type DeckSummary, type Exam, type Semester, type SidecarClient } from '../engine/client.js';
import { countdown, nextExam, orderSemesters, roomBefore, semesterOf, shortDate, termState, ymd } from './class-rules.js';
import { deckStatus, deckSteps } from './deck-list.js';
import { readNewPerDay } from './study.js';

export interface ClassPaneOptions {
  sidecar: SidecarClient;
  decksRoot: string;
  say(text: string, isError?: boolean): void;
  /** The class's record changed, as the engine now has it. */
  changed(summary: ClassSummary): void;
  /** The deck's exam changed; the strip is redrawn by the caller. */
  deckChanged(cls: CourseClass | null): void;
  openClass(path: string): void;
  /** Back to a plain folder, with the way back. */
  unclass(cls: ClassSummary): void;
  openSettings(): void;
  /** The semesters there are, for the picker that moves the class between them. */
  semesters(): Semester[];
  /** The class, and its decks, into a semester ("" for none); resolves true when it moved. */
  moveClass(cls: ClassSummary, semester: string): Promise<boolean>;
  /** The decks there are; the class shows those in it. */
  decks(): DeckSummary[];
  openDeck(deck: DeckSummary): void;
  /** A new deck by its full name, in the class's folder. */
  newDeck(name: string): void;
}

export interface ClassPane {
  /** The open class: its exams, to edit. */
  showClass(cls: ClassSummary): void;
  /** A deck: the class it is in and the exam it is for; hidden when it is in none. */
  showDeck(cls: CourseClass | null, deckPath: string): void;
  hide(): void;
  /** Puts the cursor in the class's new-deck name. */
  focusNewDeck(): void;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** "in 17 days · about 340 new cards fit at 20 a day", or what is known of it. */
function when(exam: Exam): string {
  if (!exam.date) return 'no date yet';
  const room = roomBefore(exam, readNewPerDay());
  const off = countdown(exam.date);
  return room === null ? off : `${off} · about ${room} new cards fit at ${readNewPerDay()} a day`;
}

/**
 * `host` takes what leads -- a class's decks, a deck's class strip -- and
 * `more` what follows the class's docs: its exams, its semester.
 */
export function mountClassPane(host: HTMLElement, more: HTMLElement, opts: ClassPaneOptions): ClassPane {
  function on<K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void): void {
    host.addEventListener(type, fn);
    more.addEventListener(type, fn);
  }
  const inside = (el: Element | null): boolean => !!el && (host.contains(el) || more.contains(el));
  let mode: { kind: 'class'; cls: ClassSummary } | { kind: 'deck'; cls: CourseClass; path: string } | null = null;
  /** A new exam row not yet named, kept across redraws until it is. */
  let draft = false;
  let confirmUnclass = false;

  function renderClass(cls: ClassSummary): void {
    const rows = cls.exams.map(
      (e) => `<li class="exam" data-id="${esc(e.id)}">
        <input class="ex-name" value="${esc(e.name)}" aria-label="Exam name" autocomplete="off" spellcheck="false">
        <input class="ex-date" type="date" value="${esc(e.date ?? '')}" aria-label="Date of ${esc(e.name)}">
        <input class="ex-covers" value="${esc(e.covers ?? '')}" placeholder="What it covers" aria-label="What ${esc(e.name)} covers" autocomplete="off">
        <span class="ex-when${e.date && e.date < ymd() ? ' past' : ''}">${esc(when(e))}</span>
        <button type="button" class="tremove" data-remove-exam title="Remove ${esc(e.name)}" aria-label="Remove ${esc(e.name)}">×</button>
      </li>`,
    );
    if (draft)
      rows.push(`<li class="exam draft" data-id="">
        <input class="ex-name" value="" placeholder="Exam name — Midterm 2" aria-label="New exam's name" autocomplete="off" spellcheck="false">
        <input class="ex-date" type="date" value="" aria-label="New exam's date">
        <input class="ex-covers" value="" placeholder="What it covers" aria-label="What the new exam covers" autocomplete="off">
        <span class="ex-when">name it to keep it</span>
        <button type="button" class="tremove" data-remove-exam title="Drop this row" aria-label="Drop this row">×</button>
      </li>`);
    const next = nextExam(cls.exams);
    // The class's decks first: what a student opens it for, most days.
    const mine = opts
      .decks()
      .filter((d) => d.name === cls.folder || d.name.startsWith(`${cls.folder}::`))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    const leaf = (n: string) => (n === cls.folder ? n.split('::').pop()! : n.slice(cls.folder.length + 2));
    const deckRows = mine.map((d) => {
      const steps = deckSteps(d);
      return `<li><button type="button" class="cdeck" data-deck="${esc(d.path)}" title="${esc(d.name)}"><strong>${esc(leaf(d.name))}</strong><span class="cdeck-state">${esc(deckStatus(d))}</span><span class="dsteps${steps === 0 ? '' : steps >= 5 ? ' finished' : ' started'}"><span class="dtrack"><i style="width:${(steps / 8) * 100}%"></i></span><span class="dcount">${steps} / 8</span></span></button></li>`;
    });
    host.innerHTML = `
      <header class="mhead"><h3>Decks <small>${mine.length || ''}</small></h3></header>
      ${deckRows.length ? `<ul class="cdecks">${deckRows.join('')}</ul>` : ''}
      <form class="cnewdeck" data-new-deck><input name="deck" placeholder="${mine.length ? 'Next deck' : 'First deck'} — Lecture 4: Bone" aria-label="New deck in ${esc(cls.folder)}" autocomplete="off" spellcheck="false"><button type="submit">New deck</button></form>`;
    more.innerHTML = `
      <header class="mhead cexams-head"><h3>Exams <small>${cls.exams.length || ''}</small></h3><span class="grow"></span><button type="button" class="quiet" data-add-exam>Add exam</button></header>
      ${rows.length ? `<ul class="exams">${rows.join('')}</ul>` : `<p class="muted exams-empty">No exams yet. The class brief finds them in the syllabus for you to check, or add one.</p>`}
      <p class="hint">Each deck in ${esc(cls.folder)} is studied for ${next ? `the next exam — ${esc(next.name)} — unless you pick another on the deck` : 'the next exam on the calendar, unless you pick another on the deck'}; organize sizes it to what ${readNewPerDay()} new cards a day reviews before then. <button type="button" class="link" data-settings>Change the rate in Settings</button></p>
      <footer class="class-foot">${termPicker(cls)}${
        confirmUnclass
          ? `<span>Make ${esc(cls.folder)} a plain folder? Its decks stay; the class's files and brief go to the trash for 30 days.</span><button type="button" class="danger" data-unclass-yes>Make it plain</button><button type="button" class="quiet" data-unclass-no>Keep the class</button>`
          : `<button type="button" class="quiet" data-unclass>Make it a plain folder…</button>`
      }</footer>`;
    if (draft) more.querySelector<HTMLInputElement>('.exam.draft .ex-name')?.focus();
  }

  /** Which semester the class is in, and the way to another. Moving it renames its folder, and every deck in it. */
  function termPicker(cls: ClassSummary): string {
    const terms = opts.semesters();
    const here = semesterOf(cls.folder, terms)?.folder ?? '';
    const label = (t: Semester) => `${t.folder}${termState(t) === 'now' ? ' · now' : termState(t) === 'past' ? ' · past' : ''}`;
    return `<label class="cs-exam class-term">Semester <select data-term aria-label="The semester this class is in">
      ${orderSemesters(terms).map((t) => `<option value="${esc(t.folder)}"${t.folder === here ? ' selected' : ''}>${esc(label(t))}</option>`).join('')}
      <option value=""${here ? '' : ' selected'}>No semester</option></select></label><span class="grow"></span>`;
  }

  function renderDeck(cls: CourseClass): void {
    const past = (e: Exam) => !!e.date && e.date < ymd();
    const label = (e: Exam) => `${e.name}${e.date ? ` · ${shortDate(e.date)}` : ' · no date'}${past(e) ? ' (past)' : ''}`;
    const next = nextExam(cls.exams);
    const options = [
      `<option value="next"${cls.choice === 'next' ? ' selected' : ''}>${esc(next ? `Next exam — ${label(next)}` : 'Next exam — none ahead')}</option>`,
      ...cls.exams.map((e) => `<option value="${esc(e.id)}"${cls.choice === e.id ? ' selected' : ''}>${esc(label(e))}</option>`),
      `<option value="none"${cls.choice === 'none' ? ' selected' : ''}>No exam</option>`,
    ];
    const brief = cls.brief === 'none' ? 'no class brief yet' : cls.brief === 'written' ? 'class.md goes to every step (not yet read)' : 'class.md goes to every step';
    more.innerHTML = '';
    host.innerHTML = `<div class="class-strip">
      <span class="cs-k">Class</span><button type="button" class="link cs-name" data-open-class>${esc(cls.folder)}</button><span class="cs-brief">${esc(brief)}</span>
      <label class="cs-exam">Studied for <select data-exam aria-label="The exam this deck is studied for">${options.join('')}</select></label>
      <span class="cs-when">${cls.exam ? esc(when(cls.exam)) : 'organize is told no exam date'}</span>
    </div>`;
  }

  // Whether it shows is the shell's (app.ts): empty, it has nothing to show.
  function render(): void {
    if (!mode) {
      host.innerHTML = more.innerHTML = '';
      return;
    }
    if (mode.kind === 'class') renderClass(mode.cls);
    else renderDeck(mode.cls);
  }

  /** Every named row as the person left it; a row with no name is not an exam yet. */
  function rowsNow(): (Omit<Exam, 'id'> & { id?: string })[] {
    return [...more.querySelectorAll<HTMLElement>('.exam')]
      .map((li) => ({
        ...(li.dataset.id ? { id: li.dataset.id } : {}),
        name: li.querySelector<HTMLInputElement>('.ex-name')!.value.trim(),
        date: li.querySelector<HTMLInputElement>('.ex-date')!.value || null,
        covers: li.querySelector<HTMLInputElement>('.ex-covers')!.value.trim(),
      }))
      .filter((e) => e.name);
  }

  async function save(exams: (Omit<Exam, 'id'> & { id?: string })[]): Promise<void> {
    if (mode?.kind !== 'class') return;
    const cls = mode.cls;
    try {
      const r = await opts.sidecar.updateClass(opts.decksRoot, cls.path, exams);
      if (mode?.kind === 'class' && mode.cls.path === cls.path) mode = { kind: 'class', cls: r };
      opts.changed(r);
    } catch (err) {
      opts.say(err instanceof EngineError ? err.message : String(err), true);
    }
    // The save lands after the person has moved on -- tabbed from the name to
    // the date, say. The redraw puts them back where they went, by row and field.
    const at = document.activeElement?.closest<HTMLElement>('.exam') && more.contains(document.activeElement) ? document.activeElement : null;
    const rows = [...more.querySelectorAll('.exam')];
    const where = at ? { row: rows.indexOf(at.closest('.exam')!), field: [...at.classList].find((c) => c.startsWith('ex-')) } : null;
    render();
    if (where?.field && where.row >= 0) more.querySelectorAll<HTMLElement>('.exam')[where.row]?.querySelector<HTMLElement>(`.${where.field}`)?.focus();
  }

  on('change', (e) => {
    const t = e.target as HTMLElement;
    if (mode?.kind === 'class' && t.closest('.exam')) {
      // A draft that has been named is an exam now.
      if (t.closest('.exam.draft') && !(t.closest('.exam.draft')!.querySelector<HTMLInputElement>('.ex-name')!.value.trim())) return;
      draft = false;
      void save(rowsNow());
      return;
    }
    const term = t.closest<HTMLSelectElement>('select[data-term]');
    if (term && mode?.kind === 'class') {
      const cls = mode.cls;
      term.disabled = true;
      void opts.moveClass(cls, term.value).then(() => render());
      return;
    }
    const select = t.closest<HTMLSelectElement>('select[data-exam]');
    if (select && mode?.kind === 'deck') {
      const { path } = mode;
      void opts.sidecar
        .setDeckExam(opts.decksRoot, path, select.value)
        .then((r) => {
          if (mode?.kind === 'deck' && mode.path === path && r.class) mode = { kind: 'deck', cls: r.class, path };
          render();
          opts.deckChanged(r.class);
        })
        .catch((err: unknown) => opts.say(err instanceof EngineError ? err.message : String(err), true));
    }
  });

  on('submit', (e) => {
    const form = (e.target as HTMLElement).closest<HTMLFormElement>('form[data-new-deck]');
    if (!form || mode?.kind !== 'class') return;
    e.preventDefault();
    const input = form.querySelector<HTMLInputElement>('input[name=deck]')!;
    const name = input.value.trim();
    if (!name) return input.focus();
    input.value = '';
    opts.newDeck(`${mode.cls.folder}::${name}`);
  });

  on('keydown', (e) => {
    const input = (e.target as HTMLElement).closest<HTMLInputElement>('.exam input');
    if (input && e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    }
  });

  on('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-settings]')) return opts.openSettings();
    if (mode?.kind === 'deck') {
      if (t.closest('[data-open-class]')) opts.openClass(mode.cls.path);
      return;
    }
    if (mode?.kind !== 'class') return;
    const deckButton = t.closest<HTMLElement>('[data-deck]');
    const deck = deckButton && opts.decks().find((d) => d.path === deckButton.dataset.deck);
    if (deck) return opts.openDeck(deck);
    if (t.closest('[data-add-exam]')) {
      draft = true;
      return render();
    }
    const remove = t.closest<HTMLElement>('[data-remove-exam]');
    if (remove) {
      const li = remove.closest<HTMLElement>('.exam')!;
      if (li.classList.contains('draft')) {
        draft = false;
        return render();
      }
      li.remove();
      return void save(rowsNow());
    }
    if (t.closest('[data-unclass]')) {
      confirmUnclass = true;
      return render();
    }
    if (t.closest('[data-unclass-no]')) {
      confirmUnclass = false;
      return render();
    }
    if (t.closest('[data-unclass-yes]')) {
      confirmUnclass = false;
      opts.unclass(mode.cls);
    }
  });

  return {
    showClass(cls) {
      if (mode?.kind !== 'class' || mode.cls.path !== cls.path) {
        draft = false;
        confirmUnclass = false;
      }
      mode = { kind: 'class', cls };
      // Not while the person is typing in it: a refresh landing would take the row from under them.
      if (document.activeElement?.closest('.exam, form[data-new-deck]') && inside(document.activeElement)) return;
      render();
    },
    showDeck(cls, path) {
      mode = cls ? { kind: 'deck', cls, path } : null;
      render();
    },
    hide() {
      mode = null;
      render();
    },
    focusNewDeck() {
      const input = host.querySelector<HTMLInputElement>('form[data-new-deck] input');
      input?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      input?.focus();
    },
  };
}
