/**
 * TaskFormModal time corner-case regression tests (form route of "Fix all").
 * Tests the pure helpers exported from TaskFormModal: 1440, unpadded times,
 * cross-midnight, 24:00, and invalid input.
 */
import { isSlotOrderValid, slotPrefixOf } from '../src/ui/modals/TaskFormModal';
import { minToHm } from '../src/utils/timeOfDay';

describe('authoritative helper minToHm', () => {
  test.each([
    [1440, '24:00'],
    [1260, '21:00'],
    [0, '00:00'],
    [870, '14:30'],
  ])('minToHm(%i) === %s', (min, expected) => {
    expect(minToHm(Number(min))).toBe(expected);
  });
});

describe('isSlotOrderValid', () => {
  test.each([
    ['09:00', '10:30', true],
    ['9:00', '10:00', true],
    ['21:00', '23:59', true],
    ['21:00', '00:00', true],
    ['23:30', '00:00', true],
    ['21:00', '24:00', true],
    ['00:00', '00:00', true],
    ['00:00', '23:00', true],
    ['09:00', '09:00', false],
    ['10:00', '09:00', false],
    ['09:00', 'abc', false],
    ['abc', '10:00', false],
    ['', '09:00', false],
    ['09:00', '', false],
  ])('isSlotOrderValid(%s, %s) === %s', (start, end, expected) => {
    expect(isSlotOrderValid(String(start), String(end))).toBe(expected);
  });
});

describe('slotPrefixOf', () => {
  test.each([
    ['', '10:00', null],
    ['09:00', '', '09:00'],
    ['09:00', '10:30', '09:00 - 10:30'],
    ['9:00', '10:00', '9:00 - 10:00'],
    ['21:00', '00:00', '21:00 - 00:00'],
    ['21:00', '24:00', '21:00 - 24:00'],
    ['10:00', '09:00', '10:00'],
    ['09:00', '09:00', '09:00'],
    ['09:00', 'abc', '09:00'],
  ])('slotPrefixOf(%s, %s) === %s', (start, end, expected) => {
    expect(slotPrefixOf(String(start), String(end))).toBe(expected);
  });
});
