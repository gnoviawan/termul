import { HugeiconsIcon } from "@hugeicons/react";
import { GithubIcon } from "@hugeicons/core-free-icons";
import { Button } from "./Button";
import { Logo } from "./Logo";
import {
  CONTRIBUTING_URL,
  DOCS_URL,
  GITHUB_REPO_URL,
  ISSUES_URL,
  LATEST_RELEASE_URL,
  LICENSE_URL,
  PULLS_URL,
} from "../lib/links";

const Footer = () => {
  return (
    <footer id="download" className="mt-20 border-t border-white/10 pt-20 pb-10 px-6 bg-black">
      <div className="max-w-6xl mx-auto">
        <div className="flex flex-col items-center text-center mb-24">
          <h2 className="text-3xl md:text-5xl font-medium tracking-tight mb-8 text-balance">
            Take control of your terminal.
          </h2>
          <div className="flex items-center gap-4">
            <Button as="a" href={LATEST_RELEASE_URL} target="_blank" rel="noreferrer" size="md">
              Download Termul
            </Button>
            <Button as="a" href={GITHUB_REPO_URL} target="_blank" rel="noreferrer" variant="dark" size="md">
              <HugeiconsIcon icon={GithubIcon} className="w-4 h-4" />
              GitHub
            </Button>
          </div>
        </div>
        
        <div className="grid grid-cols-2 md:grid-cols-5 gap-8 border-t border-white/10 pt-12">
          <div className="col-span-2 md:col-span-2">
            <Logo className="mb-6" textClassName="text-lg" />
            <p className="text-sm text-gray-500 max-w-xs leading-relaxed">
              A modern, project-aware terminal manager built with Tauri. Organize terminals by project with persistent sessions.
            </p>
          </div>
          
          <div>
            <h4 className="font-medium mb-4 text-sm text-white">Downloads</h4>
            <ul className="flex flex-col gap-3 text-sm text-gray-500">
              <li><a href={LATEST_RELEASE_URL} target="_blank" rel="noreferrer" className="hover:text-white transition-[color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.97]">Windows (x64)</a></li>
              <li><a href={LATEST_RELEASE_URL} target="_blank" rel="noreferrer" className="hover:text-white transition-[color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.97]">macOS (Apple Silicon)</a></li>
              <li><a href={LATEST_RELEASE_URL} target="_blank" rel="noreferrer" className="hover:text-white transition-[color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.97]">macOS (Intel)</a></li>
              <li><a href={LATEST_RELEASE_URL} target="_blank" rel="noreferrer" className="hover:text-white transition-[color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.97]">Linux (x64)</a></li>
            </ul>
          </div>
          
          <div>
            <h4 className="font-medium mb-4 text-sm text-white">Resources</h4>
            <ul className="flex flex-col gap-3 text-sm text-gray-500">
              <li><a href={DOCS_URL} target="_blank" rel="noreferrer" className="hover:text-white transition-[color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.97]">Documentation</a></li>
              <li><a href={ISSUES_URL} target="_blank" rel="noreferrer" className="hover:text-white transition-[color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.97]">Report an Issue</a></li>
              <li><a href={PULLS_URL} target="_blank" rel="noreferrer" className="hover:text-white transition-[color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.97]">Pull Requests</a></li>
              <li><a href={CONTRIBUTING_URL} target="_blank" rel="noreferrer" className="hover:text-white transition-[color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.97]">Contributing</a></li>
            </ul>
          </div>
          
          <div>
            <h4 className="font-medium mb-4 text-sm text-white">Project</h4>
            <ul className="flex flex-col gap-3 text-sm text-gray-500">
              <li><a href={GITHUB_REPO_URL} target="_blank" rel="noreferrer" className="hover:text-white transition-[color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.97]">GitHub Repository</a></li>
              <li><a href={LICENSE_URL} target="_blank" rel="noreferrer" className="hover:text-white transition-[color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.97]">License (MIT)</a></li>
              <li><a href="https://tauri.app" target="_blank" rel="noreferrer" className="hover:text-white transition-[color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.97]">Built with Tauri</a></li>
            </ul>
          </div>
        </div>
        
        <div className="mt-12 pt-8 border-t border-white/5 flex flex-col md:flex-row items-center justify-between gap-4 text-sm text-gray-600">
          <p>© {new Date().getFullYear()} Termul Contributors. MIT Licensed.</p>
          <div className="flex items-center gap-4">
            <a href={GITHUB_REPO_URL} target="_blank" rel="noreferrer" className="hover:text-white transition-[color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.97]">GitHub</a>
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;