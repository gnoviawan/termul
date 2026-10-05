import { useRef } from 'react';

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from '@/components/ui/avatar';
import { HoverTooltip } from '@/components/ui/tooltip';

import { getDisplayContributors } from '../../lib/contributors';
import { cn } from '../../lib/utils';
import { SectionHeader } from '../ui/SectionHeader';

function setAvatarShifts(
  root: HTMLElement,
  activeIdx: number | null,
  phase: 'in' | 'out',
) {
  const styles = getComputedStyle(document.documentElement);
  const readNumber = (name: string, fallback: number) => {
    const value = parseFloat(styles.getPropertyValue(name));
    return Number.isFinite(value) ? value : fallback;
  };
  const readEase = (name: string, fallback: string) =>
    styles.getPropertyValue(name).trim() || fallback;

  const lift = readNumber('--avatar-lift', -4);
  const falloff = readNumber('--avatar-falloff', 0.45);
  const scale = readNumber('--avatar-scale', 1.05);
  const timing =
    phase === 'out'
      ? readEase('--avatar-ease-out', 'cubic-bezier(0.34, 3.85, 0.64, 1)')
      : readEase('--avatar-ease-in', 'cubic-bezier(0.22, 1, 0.36, 1)');

  root.querySelectorAll<HTMLElement>('.t-avatar').forEach((el, index) => {
    el.style.transitionTimingFunction = timing;
    if (activeIdx == null) {
      el.style.setProperty('--shift', '0px');
      el.style.setProperty('--scale-active', '1');
      return;
    }

    const distance = Math.abs(index - activeIdx);
    el.style.setProperty(
      '--shift',
      (lift * Math.pow(falloff, distance)).toFixed(3) + 'px',
    );
    el.style.setProperty(
      '--scale-active',
      index === activeIdx ? String(scale) : '1',
    );
  });
}

function contributorProfileUrl(username: string) {
  return `https://github.com/${username}`;
}

export function ContributorsSection() {
  const contributors = getDisplayContributors();
  const count = contributors.length;
  const groupRef = useRef<HTMLUListElement>(null);

  return (
    <section
      aria-labelledby="contributors-heading"
      className="px-6 py-20"
      data-testid="contributors-section"
    >
      <div className="relative mx-auto max-w-5xl">
        <SectionHeader
          align="center"
          title={
            <span className="inline-flex items-center justify-center gap-3">
              Contributors
              <span
                aria-label={`${count} contributors`}
                className="inline-flex min-w-7 items-center justify-center rounded-full bg-muted px-2.5 py-0.5 text-sm font-medium tabular-nums text-muted-foreground"
              >
                {count}
              </span>
            </span>
          }
          titleId="contributors-heading"
          className="mb-10 w-full max-w-2xl space-y-2"
          titleClassName="mb-0 text-3xl md:text-4xl"
        />

        <ul
          ref={groupRef}
          aria-label="Project contributors"
          className="flex flex-wrap justify-center gap-2.5 sm:gap-3"
          onMouseLeave={() => {
            if (groupRef.current) setAvatarShifts(groupRef.current, null, 'out');
          }}
        >
          {contributors.map((contributor, index) => (
            <li
              key={contributor.username}
              className="t-avatar"
              onMouseEnter={() => {
                if (groupRef.current) setAvatarShifts(groupRef.current, index, 'in');
              }}
            >
              <ContributorAvatar {...contributor} />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function ContributorAvatar({
  username,
  avatarUrl,
}: {
  username: string;
  avatarUrl: string;
}) {
  const profileUrl = contributorProfileUrl(username);

  return (
    <HoverTooltip label={`@${username}`}>
      <a
        className={cn(
          'pressable block rounded-full outline-none',
          'ring-offset-background focus-visible:ring-2 focus-visible:ring-white/30 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        )}
        href={profileUrl}
        rel="noopener noreferrer"
        target="_blank"
        aria-label={`@${username} on GitHub`}
      >
        <Avatar className="size-11 rounded-full border border-white/10 sm:size-12">
          <AvatarImage
            alt=""
            src={avatarUrl}
          />
          <AvatarFallback className="bg-accent text-foreground text-sm">
            {username.charAt(0).toUpperCase()}
          </AvatarFallback>
        </Avatar>
      </a>
    </HoverTooltip>
  );
}
