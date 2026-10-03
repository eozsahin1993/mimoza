import { createElement, useEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { useMessages, type MessageController } from '@/core/hooks/use-messages';
import { showDone, showError, showMessage } from '@/core/services/messages';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let renderer: ReactTestRenderer;
const latest: { current: MessageController | null } = { current: null };

/** What the hook returned on the last render. */
function host(): MessageController {
  if (!latest.current) throw new Error('The host has not rendered.');
  return latest.current;
}

function Host() {
  const controller = useMessages();
  useEffect(() => {
    latest.current = controller;
  });
  return null;
}

beforeEach(() => {
  jest.useFakeTimers();
  act(() => {
    renderer = create(createElement(Host));
  });
});

afterEach(() => {
  act(() => renderer.unmount());
  jest.useRealTimers();
});

function wait(ms: number) {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

describe('how long a message stands', () => {
  // An error used to have no deadline at all and stayed until swiped away,
  // which in an app whose messages are nearly all errors read as a bar
  // that was stuck.
  test.each([
    ['a confirmation', () => showDone('Saved'), 3000],
    ['a notice', () => showMessage('Noted'), 4000],
    ['an error', () => showError('Could not refresh'), 6000],
  ])('%s leaves by itself, and not before its time', (_name, show, ms) => {
    act(show);
    expect(host().visible).toBe(true);

    wait(ms - 1);
    expect(host().visible).toBe(true);

    wait(1);
    expect(host().visible).toBe(false);
  });

  test('an action gives it longer, an error included, so there is room to reach it', () => {
    act(() => showError('Could not delete', { action: { label: 'Retry', onPress: jest.fn() } }));

    wait(6001);
    expect(host().visible).toBe(true);

    wait(2000);
    expect(host().visible).toBe(false);
  });

  test('an action extends a confirmation too', () => {
    act(() => showDone('Photo deleted', { action: { label: 'Undo', onPress: jest.fn() } }));

    wait(3001);
    expect(host().visible).toBe(true);

    wait(5000);
    expect(host().visible).toBe(false);
  });

  test('dismissing takes it away early', () => {
    act(() => showError('Could not refresh'));

    act(() => host().dismiss());

    expect(host().visible).toBe(false);
  });
});

describe('what follows a message', () => {
  // The leaving message's timer must not carry over: the next one gets
  // all of its own time.
  test('the next message gets its full time, not what was left of the last', () => {
    act(() => showDone('First'));
    wait(2500);

    act(() => showError('Second'));
    expect(host().visible).toBe(false);

    act(() => host().settle());
    expect(host().message?.text).toBe('Second');
    expect(host().visible).toBe(true);

    wait(5999);
    expect(host().visible).toBe(true);

    wait(1);
    expect(host().visible).toBe(false);
  });

  test('a burst keeps one behind the one on screen and drops the rest', () => {
    act(() => showError('First'));
    act(() => showError('Second'));
    act(() => showError('Third'));

    act(() => host().settle());
    expect(host().message?.text).toBe('Second');

    act(() => host().dismiss());
    act(() => host().settle());
    expect(host().message).toBeNull();
  });
});
