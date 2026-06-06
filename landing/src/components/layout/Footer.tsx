import { FooterColumn, FooterLink, type FooterLink as FooterLinkData } from './FooterLinks';
import { Logo } from "../ui/Logo";
import { ProductCta } from '../ui/ProductCta';
import { SectionHeader } from '../ui/SectionHeader';
import {
  CONTRIBUTING_URL,
  DOCS_URL,
  GITHUB_REPO_URL,
  ISSUES_URL,
  LATEST_RELEASE_URL,
  LICENSE_URL,
  PULLS_URL,
} from "../../lib/links";

const footerColumns: { title: string; links: FooterLinkData[] }[] = [
  {
    title: 'Downloads',
    links: [
      { label: 'Windows (x64)', href: LATEST_RELEASE_URL },
      { label: 'macOS (Apple Silicon)', href: LATEST_RELEASE_URL },
      { label: 'macOS (Intel)', href: LATEST_RELEASE_URL },
      { label: 'Linux (x64)', href: LATEST_RELEASE_URL },
    ],
  },
  {
    title: 'Resources',
    links: [
      { label: 'Documentation', href: DOCS_URL },
      { label: 'Report an Issue', href: ISSUES_URL },
      { label: 'Pull Requests', href: PULLS_URL },
      { label: 'Contributing', href: CONTRIBUTING_URL },
    ],
  },
  {
    title: 'Project',
    links: [
      { label: 'GitHub Repository', href: GITHUB_REPO_URL },
      { label: 'License (MIT)', href: LICENSE_URL },
      { label: 'Built with Tauri', href: 'https://tauri.app' },
    ],
  },
];

export const Footer = () => {
  return (
    <footer id="download" className="mt-20 border-t border-border-subtle pt-20 pb-10 px-6 bg-background">
      <div className="max-w-6xl mx-auto">
        <div className="flex flex-col items-center text-center mb-24">
          <SectionHeader
            align="center"
            title="Take control of your terminal."
            className="mb-8"
            titleClassName="mb-0 text-3xl md:text-5xl"
          />
          <ProductCta variant="footer" />
        </div>
        
        <div className="grid grid-cols-2 md:grid-cols-5 gap-8 border-t border-border-subtle pt-12">
          <div className="col-span-2 md:col-span-2">
            <Logo className="mb-6" textClassName="text-lg" />
            <p className="text-sm text-gray-500 max-w-xs leading-relaxed">
              A modern, project-aware terminal manager built with Tauri. Organize terminals by project with persistent sessions.
            </p>
          </div>
          
          {footerColumns.map((column) => (
            <FooterColumn key={column.title} {...column} />
          ))}
        </div>
        
        <div className="mt-12 pt-8 border-t border-border-subtle flex flex-col md:flex-row items-center justify-between gap-4 text-sm text-gray-600">
          <p>© {new Date().getFullYear()} Termul Contributors. MIT Licensed.</p>
          <div className="flex items-center gap-4">
            <FooterLink href={GITHUB_REPO_URL}>GitHub</FooterLink>
          </div>
        </div>
      </div>
    </footer>
  );
};