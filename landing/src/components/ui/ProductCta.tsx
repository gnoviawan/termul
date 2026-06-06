import { ArrowRight01Icon, GithubIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';

import { GITHUB_REPO_URL, LATEST_RELEASE_URL } from '../../lib/links';
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
        className={config.buttonClassName}
      >
        {config.downloadLabel}
        {config.showDownloadArrow && (
          <HugeiconsIcon icon={ArrowRight01Icon} className="h-4 w-4" />
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
