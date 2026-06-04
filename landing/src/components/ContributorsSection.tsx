import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from '@/components/ui/avatar';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

import { contributors } from '../data/contributors';
import { cn } from '../lib/utils';
import { SectionHeader } from './SectionHeader';

function contributorProfileUrl(username: string) {
  return `https://github.com/${username}`;
}

export function ContributorsSection() {
  const count = contributors.length;

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

        <TooltipProvider delayDuration={120}>
          <ul
            aria-label="Project contributors"
            className="flex flex-wrap justify-center gap-2.5 sm:gap-3"
          >
            {contributors.map((contributor) => (
              <li key={contributor.username}>
                <ContributorAvatar {...contributor} />
              </li>
            ))}
          </ul>
        </TooltipProvider>
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
    <Tooltip>
      <TooltipTrigger asChild>
        <a
          className={cn(
            'pressable block rounded-full outline-none',
            'ring-offset-background focus-visible:ring-2 focus-visible:ring-white/30 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            'transition-transform duration-200 ease-[var(--ease-out)] hover:scale-105',
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
      </TooltipTrigger>
      <TooltipContent side="top">
        @{username}
      </TooltipContent>
    </Tooltip>
  );
}
