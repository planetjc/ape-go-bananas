// A class's rules: which folder can be one, how far off an exam is, and how
// the exams the agent found in the syllabus join the ones the person keeps.
import assert from 'node:assert/strict';
import test from 'node:test';

import type { ClassSummary, Exam, Semester } from '../src/engine/client.ts';
import { canBeClass, countdown, daysUntil, defaultSemester, mergeExams, nextExam, nextTerm, orderSemesters, parseFoundExams, roomBefore, semesterOf, shortDate, suggestTerm, termFromName, termRange, termState, upcomingExams } from '../src/agent/class-rules.ts';

const TODAY = new Date(2026, 8, 27, 23, 30); // Sep 27, late in the evening: still the 27th
const cls = (folder: string): ClassSummary => ({ folder, path: `/c/${folder}`, exams: [], brief: 'none', files: 0 });
const exam = (id: string, name: string, date: string | null, covers?: string): Exam => ({ id, name, date, ...(covers ? { covers } : {}) });

test('one class to a deck: a folder inside a class, or holding one, cannot be one', () => {
  const classes = [cls('Year 1::Histology')];
  assert.equal(canBeClass('Year 1::Pharm', classes), true);
  assert.equal(canBeClass('Year 1', classes), false, 'holds a class');
  assert.equal(canBeClass('Year 1::Histology::Lab', classes), false, 'inside a class');
  assert.equal(canBeClass('Year 1::Histology', classes), false, 'is one');
});

test('days and countdowns are counted on the calendar, not the clock', () => {
  assert.equal(daysUntil('2026-09-27', TODAY), 0);
  assert.equal(daysUntil('2026-09-28', TODAY), 1, 'tomorrow is one day off at 23:30');
  assert.equal(daysUntil('2026-10-14', TODAY), 17);
  assert.equal(countdown('2026-09-27', TODAY), 'today');
  assert.equal(countdown('2026-09-28', TODAY), 'tomorrow');
  assert.equal(countdown('2026-09-26', TODAY), 'yesterday');
  assert.equal(countdown('2026-10-14', TODAY), 'in 17 days');
  assert.equal(countdown('2026-09-20', TODAY), '7 days ago');
  assert.equal(shortDate('2026-10-14', TODAY), 'Oct 14');
  assert.equal(shortDate('2027-01-05', TODAY), 'Jan 5, 2027');
});

test('the next exam is the soonest still ahead, today included; the room is days times the rate', () => {
  const exams = [exam('e1', 'Midterm 1', '2026-09-20'), exam('e3', 'Final', null), exam('e2', 'Midterm 2', '2026-10-14'), exam('e4', 'Quiz', '2026-09-27')];
  assert.equal(nextExam(exams, TODAY)?.name, 'Quiz');
  assert.equal(nextExam(exams.filter((e) => e.id !== 'e4'), TODAY)?.name, 'Midterm 2');
  assert.equal(nextExam([exam('e1', 'Old', '2026-01-01')], TODAY), null);
  assert.equal(roomBefore(exams[2]!, 20, TODAY), 340);
  assert.equal(roomBefore(exams[0]!, 20, TODAY), null, 'passed');
  assert.equal(roomBefore(exams[1]!, 20, TODAY), null, 'no date');
});

test('exams.json is read loosely: an array or {exams}, a name required, a date only if it is one', () => {
  assert.deepEqual(parseFoundExams('not json'), []);
  assert.deepEqual(
    parseFoundExams(JSON.stringify([{ name: ' Midterm   1 ', date: '2026-10-14', covers: 'Lectures 1–6 ' }, { name: '', date: '2026-10-01' }, { name: 'Final', date: 'Dec 12' }, 'x'])),
    [{ name: 'Midterm 1', date: '2026-10-14', covers: 'Lectures 1–6' }, { name: 'Final', date: null }],
  );
  assert.deepEqual(parseFoundExams(JSON.stringify({ exams: [{ name: 'Lab practical', date: null }] })), [{ name: 'Lab practical', date: null }]);
});

test('what the papers found joins the class\'s exams: new ones added, gaps filled, a paper\'s date moved by a newer paper', () => {
  const kept: Exam[] = [
    exam('e1', 'Midterm 1', '2026-10-12', 'lectures 1–6'), // from the syllabus
    exam('e2', 'Final', null),
    { ...exam('e3', 'Quiz', '2026-10-05'), setBy: 'person' }, // the person's own date
  ];
  const r = mergeExams(kept, [
    { name: 'midterm  1', date: '2026-10-14', covers: 'lectures 1–6, less bone remodeling' }, // a study guide moves it
    { name: 'Final', date: '2026-12-12' }, // a date it had not had
    { name: 'Quiz', date: '2026-10-06' }, // the papers disagree with the person
    { name: 'Lab practical', date: null },
  ]);
  assert.deepEqual(r.exams, [
    { id: 'e1', name: 'Midterm 1', date: '2026-10-14', covers: 'lectures 1–6, less bone remodeling' },
    { id: 'e2', name: 'Final', date: '2026-12-12' },
    { id: 'e3', name: 'Quiz', date: '2026-10-05', setBy: 'person' },
    { name: 'Lab practical', date: null },
  ]);
  assert.deepEqual([r.added, r.filled], [1, 1]);
  assert.deepEqual(r.moved, [{ name: 'Midterm 1', from: '2026-10-12', to: '2026-10-14' }]);
  assert.deepEqual(r.differ, [{ name: 'Quiz', papers: '2026-10-06', yours: '2026-10-05' }], 'said, not done');
  assert.deepEqual(kept[1], exam('e2', 'Final', null), 'the kept list is not changed in place');
  const none = mergeExams(kept, []);
  assert.deepEqual([none.added, none.filled, none.moved.length, none.differ.length], [0, 0, 0, 0]);
});

// Semesters: which is now, their order, where a new class goes, what is coming up.
const term = (folder: string, start: string | null, end: string | null): Semester => ({ folder, start, end });
const SPRING = term('Spring 2026', '2026-01-12', '2026-05-15');
const FALL = term('Fall 2026', '2026-08-24', '2026-12-18');
const NEXT = term('Spring 2027', '2027-01-11', '2027-05-14');
const LOOSE = term('Electives', null, null);

test('a semester is now, ahead, past or undated, by its dates on the calendar', () => {
  assert.equal(termState(FALL, TODAY), 'now');
  assert.equal(termState(SPRING, TODAY), 'past');
  assert.equal(termState(NEXT, TODAY), 'ahead');
  assert.equal(termState(LOOSE, TODAY), 'undated');
  assert.equal(termState(term('Open', '2026-09-01', null), TODAY), 'now', 'started, with no end set');
  assert.equal(termState(term('Last day', '2026-08-24', '2026-09-27'), TODAY), 'now', 'its last day is still in it');
});

test('semesters are listed now, then ahead, then past (latest first), undated last; a new class goes in the one under way', () => {
  const old = term('Fall 2025', '2025-08-25', '2025-12-19');
  assert.deepEqual(orderSemesters([SPRING, LOOSE, old, NEXT, FALL], TODAY).map((t) => t.folder), ['Fall 2026', 'Spring 2027', 'Spring 2026', 'Fall 2025', 'Electives']);
  assert.equal(defaultSemester([SPRING, NEXT, FALL], TODAY)?.folder, 'Fall 2026');
  assert.equal(defaultSemester([SPRING, NEXT], TODAY)?.folder, 'Spring 2027', 'none under way: the next');
  assert.equal(defaultSemester([SPRING], TODAY)?.folder, 'Spring 2026', 'only past ones: the latest');
  assert.equal(defaultSemester([LOOSE], TODAY)?.folder, 'Electives');
  assert.equal(defaultSemester([], TODAY), undefined);
});

test('a first semester is named and dated from today, or from its own name', () => {
  assert.deepEqual(suggestTerm(TODAY), { name: 'Fall 2026', start: '2026-08-24', end: '2026-12-18' });
  assert.equal(suggestTerm(new Date(2027, 1, 3)).name, 'Spring 2027');
  assert.equal(suggestTerm(new Date(2027, 5, 20)).name, 'Summer 2027');
  assert.deepEqual(termFromName('Spring 2027', TODAY), { start: '2027-01-12', end: '2027-05-15' });
  assert.deepEqual(termFromName("Year 1 — summer '28", TODAY), { start: '2028-06-01', end: '2028-08-07' });
  assert.deepEqual(termFromName('Block A', TODAY), { start: '2026-08-24', end: '2026-12-18' }, 'no season in the name: today\'s');
  assert.equal(termRange(FALL, TODAY), 'Aug 24 – Dec 18');
  assert.equal(termRange(NEXT, TODAY), 'Jan 11, 2027 – May 14, 2027');
  assert.equal(termRange(LOOSE, TODAY), 'no dates');
});

test('a class is in one semester at most; a semester or a folder holding one is not a class', () => {
  const classes = [cls('Fall 2026::Histology')];
  assert.equal(semesterOf('Fall 2026::Histology::03 Cartilage', [FALL, SPRING])?.folder, 'Fall 2026');
  assert.equal(semesterOf('Fall 2026 II::X', [FALL]), undefined, 'a name that only starts the same is not in it');
  assert.equal(canBeClass('Fall 2026', classes, [FALL]), false, 'a semester is not a class');
  assert.equal(canBeClass('Year 1', [], [term('Year 1::Fall', null, null)]), false, 'nor is a folder holding one');
  assert.equal(canBeClass('Fall 2026::Biochem', classes, [FALL]), true);
});

test('what is coming up across a semester\'s classes: soonest first, each with its class, past ones left out', () => {
  const histo = { ...cls('Fall 2026::Histology'), exams: [exam('e1', 'Midterm 1', '2026-10-12'), exam('e2', 'Quiz', '2026-09-20'), exam('e3', 'Final', null)] };
  const bio = { ...cls('Fall 2026::Biochem'), exams: [exam('e1', 'Exam 1', '2026-10-05'), exam('e2', 'Exam 2', '2026-10-12')] };
  const up = upcomingExams([histo, bio], TODAY);
  assert.deepEqual(up.map((u) => `${u.exam.date} ${u.exam.name} (${u.cls.folder.split('::')[1]})`), ['2026-10-05 Exam 1 (Biochem)', '2026-10-12 Exam 2 (Biochem)', '2026-10-12 Midterm 1 (Histology)']);
  assert.equal(upcomingExams([histo, bio], TODAY, 1).length, 1);
});

test('a new semester is suggested as the next term not made yet', () => {
  assert.deepEqual(nextTerm([], TODAY), { name: 'Fall 2026', start: '2026-08-24', end: '2026-12-18' }, 'none yet: today\'s term');
  assert.equal(nextTerm([FALL], TODAY).name, 'Spring 2027', 'Fall made: the Spring after it');
  assert.equal(nextTerm([FALL, NEXT], TODAY).name, 'Summer 2027', 'and after that, the Summer');
  assert.deepEqual(nextTerm([FALL, NEXT], TODAY), { name: 'Summer 2027', start: '2027-06-01', end: '2027-08-07' });
  assert.equal(nextTerm([SPRING], TODAY).name, 'Fall 2026', 'an old one made: today\'s is still free');
  assert.equal(nextTerm([term('Year 1::fall 2026', '2026-08-24', null)], TODAY).name, 'Spring 2027', 'names inside a folder, any case');
});
