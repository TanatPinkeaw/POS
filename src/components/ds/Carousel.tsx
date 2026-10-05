'use client';

import { Children, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { Button } from './Button';
import styles from './Carousel.module.css';

/**
 * A carousel that stays where the operator left it.
 *
 * Built for the pre-order board, where three phase columns used to grow without
 * bound: a shop with fourteen orders waiting to be confirmed got a column fourteen
 * cards tall, and the two orders at the bottom were a scroll away from a screen that
 * is looked at from standing up, across a counter, mid-conversation.
 *
 * **The position is derived from `scrollLeft`, never from props.** That is the whole
 * design, and it is chosen against the obvious alternative. A controlled carousel
 * takes an `index` prop, and the index has to be reconciled every time the slide list
 * changes — but on this board the list changes constantly, because confirming an
 * order removes it from one column and the columns are re-rendered from a server read
 * that lands whenever it lands. A controlled index would either snap to 0 (losing the
 * operator's place, mid-task, on a board that is the shop's whole morning) or drift out
 * of step with the DOM and leave the dots pointing at the wrong card.
 *
 * So this one holds its own index, updates it from the `scroll` event, and treats the
 * children as the only source of truth about how many slides there are. An order
 * leaving the queue can shift a card along and the carousel simply stays wherever it
 * is scrolled, which is the only behaviour that is defensible on a live board.
 *
 * **It never moves by itself.** No autoplay, no timer, no rotation. A carousel that
 * advances on its own takes the card away from somebody who is halfway through reading
 * it — and at a till the person reading it is the person a customer is waiting on. The
 * dot indicator and the counter exist because the cost of "it never moves by itself" is
 * that the operator has to know how many are behind the one in front of them.
 *
 * Keyboard and screen-reader behaviour follow the APG carousel pattern: a labelled
 * `region`, one slide exposed at a time, arrow keys on the viewport, and a polite live
 * region so the change is announced. The dot rail is hidden above seven slides, where
 * it stops being a position indicator and becomes a wall.
 */
export function Carousel({
  label,
  children,
  /** Shown when there are no slides at all, so callers do not need their own branch. */
  empty,
}: {
  label: string;
  children: ReactNode;
  empty?: ReactNode;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [index, setIndex] = useState(0);
  const total = Children.count(children);

  /*
   * Read the position off the scroller rather than tracking it. `scrollLeft` is the
   * truth after a drag, after a fling, after a scrollbar drag and after a snap — four
   * things a `scrollTo`-based index gets wrong or misses entirely, and a miss shows up
   * as dots claiming the operator is on card 3 while card 1 is under their thumb.
   */
  const sync = useCallback(() => {
    const viewport = viewportRef.current;
    const slide = viewport?.firstElementChild as HTMLElement | null;
    if (!viewport || !slide) {
      return;
    }
    const width = slide.getBoundingClientRect().width;
    if (width === 0) {
      return;
    }
    const next = Math.round(viewport.scrollLeft / width);
    setIndex((current) => (current === next ? current : next));
  }, []);

  // The slide count changes under us whenever an order is confirmed or expires, and
  // the new first slide is narrower or wider than the old one — so re-measure then.
  useEffect(sync, [sync, total]);

  const goTo = useCallback(
    (next: number) => {
      const viewport = viewportRef.current;
      const slide = viewport?.firstElementChild as HTMLElement | null;
      if (!viewport || !slide) {
        return;
      }
      const width = slide.getBoundingClientRect().width;
      if (width === 0) {
        // A slide that has not been laid out yet sends every arrow to offset 0, which
        // reads as a dead button. Ask again on a timer rather than a frame: frames are
        // exactly what the environments described below do not deliver, and a timer
        // still fires. Only when the scroller itself has a width, because a hidden board
        // stays hidden and retrying that would loop forever.
        if (viewport.clientWidth > 0) {
          setTimeout(() => goTo(next), 50);
        }
        return;
      }
      const clamped = Math.max(0, Math.min(next, total - 1));
      /*
       * This scrolls without animation, which is a decision rather than a default.
       *
       * `behavior: 'smooth'` is driven by the compositor, and where frames are not being
       * produced — an embedded webview or kiosk shell, a backgrounded tab, a headless
       * browser — it is not a slow animation, it is *nothing*: `scrollLeft` never leaves
       * 0, no `scroll` event fires, `sync` never notices, and the counter advances to a
       * card that is not on screen. That is a dead arrow that looks alive, which is the
       * worst failure this component can have, and it cannot be detected afterwards
       * because a timer cannot tell "still animating" from "never started".
       *
       * So the arrow is instant by construction and the animation is given up. Nothing
       * is lost in practice: a swipe — the gesture people actually use on a board, and
       * the one that deserves motion — is native scrolling and keeps its momentum, and
       * an operator pressing an arrow wants the next card now, not in 300 ms, while a
       * customer waits. `scroll-snap-type: x mandatory` on the viewport still settles
       * the landing, so a half-shown card cannot happen either way.
       */
      // Assigned rather than `scrollTo`-ed: the `scrollLeft` setter is the one scroll
      // API that is instant on every engine, with no `behavior` to resolve and no
      // animation to wait for.
      viewport.scrollLeft = clamped * width;
      setIndex(clamped);
    },
    [total],
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      goTo(index + 1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      goTo(index - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      goTo(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      goTo(total - 1);
    }
  };

  if (total === 0) {
    return <>{empty ?? null}</>;
  }

  const single = total === 1;
  const position = `${Math.min(index + 1, total)} / ${total}`;

  return (
    <div className={styles.root} role="region" aria-roledescription="carousel" aria-label={label}>
      <div
        ref={viewportRef}
        className={styles.viewport}
        tabIndex={0}
        onScroll={sync}
        onKeyDown={onKeyDown}
        aria-live="polite"
        aria-label={single ? undefined : `${label} — ใบที่ ${position}`}
      >
        {Children.map(children, (slide, slideIndex) => (
          <div
            key={slideIndex}
            className={styles.slide}
            role="group"
            aria-roledescription="สไลด์"
            aria-label={`${slideIndex + 1} จาก ${total}`}
          >
            {slide}
          </div>
        ))}
      </div>

      {single ? null : (
        <div className={styles.controls}>
          <Button
            variant="secondary"
            size="sm"
            icon="arrowLeft"
            aria-label="ก่อนหน้า"
            disabled={index <= 0}
            onClick={() => goTo(index - 1)}
          />
          <span className={styles.counter} aria-hidden="true">
            {position}
          </span>
          <Button
            variant="secondary"
            size="sm"
            icon="arrowRight"
            aria-label="ถัดไป"
            disabled={index >= total - 1}
            onClick={() => goTo(index + 1)}
          />
          {total <= 7 ? (
            <span className={styles.dots} aria-hidden="true">
              {Array.from({ length: total }, (_, dot) => (
                <button
                  key={dot}
                  type="button"
                  tabIndex={-1}
                  className={`${styles.dot} ${dot === index ? styles.dotOn : ''}`}
                  onClick={() => goTo(dot)}
                />
              ))}
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}