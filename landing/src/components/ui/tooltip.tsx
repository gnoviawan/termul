import {
  cloneElement,
  useId,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactElement,
} from 'react';

import { cn } from '@/lib/utils';

import { clampTooltipX } from '../../lib/clamp-tooltip-x';

type TooltipTriggerProps = HTMLAttributes<HTMLElement> & {
  'data-tooltip'?: string;
};

type HoverTooltipProps = {
  label: string;
  children: ReactElement<TooltipTriggerProps>;
};

/**
 * Shared transitions.dev tooltip: delayed fade and scale in, instant out.
 * One bubble per trigger so a wrapped avatar row still points at that avatar.
 */
export function HoverTooltip({ label, children }: HoverTooltipProps) {
  const groupRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(false);
  const id = useId();

  const place = (trigger: HTMLElement) => {
    const tip = tipRef.current;
    const text = textRef.current;
    const group = groupRef.current;
    if (!tip || !text || !group) return;

    const showing = tip.getAttribute('data-show') === 'true';
    const cs = getComputedStyle(tip);
    const width = Math.ceil(
      text.scrollWidth +
        parseFloat(cs.paddingLeft) +
        parseFloat(cs.paddingRight),
    );
    const groupRect = group.getBoundingClientRect();
    const triggerRect = trigger.getBoundingClientRect();
    const rawX = triggerRect.left - groupRect.left + triggerRect.width / 2 - width / 2;
    const x = clampTooltipX(rawX, width, groupRect.left, window.innerWidth);

    if (!showing) {
      tip.style.transition = 'none';
      tip.style.width = `${width}px`;
      tip.style.setProperty('--tt-x', `${x}px`);
      void tip.offsetWidth;
      tip.style.transition = '';
    } else {
      tip.style.width = `${width}px`;
      tip.style.setProperty('--tt-x', `${x}px`);
    }

    setShown(true);
  };

  const hide = () => setShown(false);

  return (
    <span
      ref={groupRef}
      className="t-tt-group"
      onPointerLeave={hide}
    >
      {cloneElement<TooltipTriggerProps>(children, {
        className: cn(children.props.className, 't-tt-trigger'),
        'data-tooltip': label,
        'aria-describedby': id,
        onPointerEnter: (event) => {
          children.props.onPointerEnter?.(event);
          place(event.currentTarget);
        },
        onFocus: (event) => {
          children.props.onFocus?.(event);
          place(event.currentTarget);
        },
        onBlur: (event) => {
          children.props.onBlur?.(event);
          hide();
        },
      })}
      <span
        ref={tipRef}
        id={id}
        role="tooltip"
        aria-hidden={shown ? 'false' : 'true'}
        data-show={shown ? 'true' : 'false'}
        className="t-tt z-20 border border-white/10 text-xs font-medium"
      >
        <span ref={textRef} className="t-tt-text">
          {label}
        </span>
      </span>
    </span>
  );
}
