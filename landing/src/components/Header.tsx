import { useState, useEffect } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { GithubIcon } from "@hugeicons/core-free-icons";
import { Button } from "./Button";
import { Logo } from "./Logo";
import { cn } from "../lib/utils";
import { DOCS_URL, GITHUB_REPO_URL, LATEST_RELEASE_URL } from "../lib/links";

const Header = () => {
  const [isScrolled, setIsScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      // Change state when scrolled past a certain threshold (e.g., 50px)
      if (window.scrollY > 50) {
        setIsScrolled(true);
      } else {
        setIsScrolled(false);
      }
    };

    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <header 
      className={cn(
        "fixed top-0 left-0 right-0 z-50 px-6 py-4 flex items-center justify-between border-b transition-[background-color,border-color,backdrop-filter] duration-200 ease-[var(--ease-out)]",
        isScrolled 
          ? "bg-black/50 backdrop-blur-md border-white/10" 
          : "bg-transparent border-transparent"
      )}
    >
      <Logo 
        textClassName={cn("transition-colors duration-200 ease-[var(--ease-out)]", isScrolled ? "text-white" : "text-black")}
        iconClassName={cn("transition-[filter] duration-200 ease-[var(--ease-out)]", isScrolled ? "" : "invert")}
      />
      
      <nav className={cn(
        "hidden md:flex items-center gap-8 text-sm absolute left-1/2 -translate-x-1/2 transition-colors duration-200 ease-[var(--ease-out)]",
        isScrolled ? "text-gray-300" : "text-black/70"
      )}>
        <a href="#features" className={cn("transition-[color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.97]", isScrolled ? "hover:text-white" : "hover:text-black")}>Features</a>
        <a href="#download" className={cn("transition-[color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.97]", isScrolled ? "hover:text-white" : "hover:text-black")}>Downloads</a>
        <a href={DOCS_URL} target="_blank" rel="noreferrer" className={cn("transition-[color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.97]", isScrolled ? "hover:text-white" : "hover:text-black")}>Docs</a>
      </nav>
      
      <div className="flex items-center gap-4 text-sm">
        <a 
          href={GITHUB_REPO_URL} 
          target="_blank" 
          rel="noreferrer" 
          className={cn(
            "flex items-center gap-2 transition-[color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.97]",
            isScrolled ? "text-white hover:text-gray-300" : "text-black hover:text-black/70"
          )}
        >
          <HugeiconsIcon icon={GithubIcon} className="w-4 h-4" />
          <span className="hidden sm:inline">GitHub</span>
        </a>
        <Button 
          as="a" 
          href={LATEST_RELEASE_URL} 
          target="_blank" 
          rel="noreferrer" 
          size="sm"
        >
          Download
        </Button>
      </div>
    </header>
  );
};

export default Header;