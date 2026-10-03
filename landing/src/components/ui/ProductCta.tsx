import { GithubIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';

import { GITHUB_REPO_URL, LATEST_RELEASE_URL } from '../../lib/links';
import { cn } from '../../lib/utils';
import { Button } from './Button';

type ProductCtaVariant = 'hero' | 'footer';

type ProductCtaProps = {
  variant: ProductCtaVariant;
};

const productCtaConfig = {
  hero: {
    wrapperClassName:
      'flex w-full max-w-md flex-col items-center justify-center gap-4 sm:flex-row',
    buttonClassName: 'w-full sm:w-auto',
    size: 'lg',
    githubVariant: 'outline',
    downloadLabel: 'Download for Free',
    showDownloadArrow: true,
  },
  footer: {
    wrapperClassName: 'flex items-center gap-4',
    buttonClassName: undefined,
    size: 'md',
    githubVariant: 'dark',
    downloadLabel: 'Download Termul',
    showDownloadArrow: false,
  },
} as const;

export function ProductCta({ variant }: ProductCtaProps) {
  const config = productCtaConfig[variant];

  return (
    <div className={config.wrapperClassName}>
      <Button
        as="a"
        href={LATEST_RELEASE_URL}
        target="_blank"
        rel="noreferrer"
        size={config.size}
        className={cn(config.buttonClassName, config.showDownloadArrow && 't-learn')}
      >
        {config.downloadLabel}
        {config.showDownloadArrow && (
          <span className="t-learn-chevron" aria-hidden="true">
            <svg
              className="h-4 w-4"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
            >
              <path
                className="t-learn-arm t-learn-arm-top"
                d="M6 4L10 8"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
              <path
                className="t-learn-arm t-learn-arm-bot"
                d="M10 8L6 12"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </span>
        )}
      </Button>
      <Button
        as="a"
        href={GITHUB_REPO_URL}
        target="_blank"
        rel="noreferrer"
        variant={config.githubVariant}
        size={config.size}
        className={config.buttonClassName}
      >
        <HugeiconsIcon icon={GithubIcon} className="h-4 w-4" />
        GitHub
      </Button>
    </div>
  );
}
