import { useState, useEffect, useRef, useCallback, type MouseEvent } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, GithubIcon, Menu01Icon } from "@hugeicons/core-free-icons";
import { Button } from "../ui/Button";
import { Logo } from "../ui/Logo";
import { cn } from "../../lib/utils";
import { DOCS_URL, GITHUB_REPO_URL, LATEST_RELEASE_URL } from "../../lib/links";
import { readCssTime } from "../../lib/read-css-time";
import { HEADER_SCROLL_OFFSET, smoothScrollToHash } from "../../lib/smooth-scroll";

export type HeaderProps = {
  /** Scroll offset of the real scroll container (e.g. OverlayScrollbars viewport). When omitted, uses `window`. */
  scrollTop?: number;
};

const SCROLLED_PX = 50;

const navLinks = [
  { href: "#features", label: "Features", external: false },
  { href: "#download", label: "Downloads", external: false },
  { href: DOCS_URL, label: "Docs", external: true },
] as const;

export const Header = ({ scrollTop: scrollTopProp }: HeaderProps) => {
  const [windowScrollY, setWindowScrollY] = useState(0);
  const [menuPhase, setMenuPhase] = useState<"closed" | "open" | "closing">("closed");
  const closeTimer = useRef<number | null>(null);
  const menuOpen = menuPhase === "open";
  const isControlled = scrollTopProp !== undefined;
  const scrollTop = scrollTopProp ?? windowScrollY;
  const isScrolled = scrollTop > SCROLLED_PX;

  useEffect(() => {
    if (isControlled) return;

    const handleScroll = () => {
      setWindowScrollY(window.scrollY);
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();
    return () => window.removeEventListener("scroll", handleScroll);
  }, [isControlled]);

  const clearCloseTimer = useCallback(() => {
    if (closeTimer.current == null) return;
    window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);

  const openMenu = useCallback(() => {
    clearCloseTimer();
    setMenuPhase("open");
  }, [clearCloseTimer]);

  const closeMenu = useCallback(() => {
    setMenuPhase((current) => (current === "open" ? "closing" : current));
  }, []);

  useEffect(() => {
    if (!menuOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeMenu, menuOpen]);

  useEffect(() => {
    if (menuPhase !== "closing") return;

    const closeMs = readCssTime("--dropdown-close-dur", 150);
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setMenuPhase("closed");
    }, closeMs);

    return () => clearCloseTimer();
  }, [clearCloseTimer, menuPhase]);

  useEffect(() => () => clearCloseTimer(), [clearCloseTimer]);

  const handleAnchorClick = (
    event: MouseEvent<HTMLAnchorElement>,
    href: string,
  ) => {
    if (!href.startsWith("#")) return;

    event.preventDefault();
    closeMenu();

    if (smoothScrollToHash(href, { offset: HEADER_SCROLL_OFFSET })) {
      window.history.pushState(null, "", href);
    }
  };

  const linkClassName = cn(
    "transition-[color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.97]",
    isScrolled ? "hover:text-white" : "hover:text-black",
  );

  const navTextClassName = cn(
    "transition-colors duration-200 ease-[var(--ease-out)]",
    isScrolled ? "text-gray-300" : "text-black/70",
  );

  return (
    <>
      <header
        className={cn(
          "fixed top-0 left-0 right-0 z-50 px-6 py-4 flex items-center justify-between md:grid md:grid-cols-[1fr_auto_1fr] border-b transition-[background-color,border-color,backdrop-filter] duration-200 ease-[var(--ease-out)]",
          isScrolled
            ? "bg-background/80 backdrop-blur-md border-border-subtle"
            : "bg-background/0 border-transparent",
        )}
      >
        <div className="min-w-0 md:justify-self-start md:col-start-1">
          <Logo
            textClassName={cn(
              "transition-colors duration-200 ease-[var(--ease-out)]",
              isScrolled ? "text-white" : "text-black",
            )}
            iconClassName={cn(
              "transition-[filter] duration-200 ease-[var(--ease-out)]",
              isScrolled ? "" : "invert",
            )}
          />
        </div>

        <nav
          className={cn(
            "hidden md:flex items-center justify-center gap-8 text-sm md:justify-self-center md:col-start-2",
            navTextClassName,
          )}
        >
          {navLinks.map((link) => (
            <a
              key={link.label}
              href={link.href}
              target={link.external ? "_blank" : undefined}
              rel={link.external ? "noreferrer" : undefined}
              onClick={
                link.external
                  ? undefined
                  : (event) => handleAnchorClick(event, link.href)
              }
              className={linkClassName}
            >
              {link.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-3 text-sm min-w-0 md:justify-self-end md:col-start-3">
          <a
            href={GITHUB_REPO_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="GitHub"
            className={cn(
              "hidden sm:flex items-center gap-2 transition-[color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.97]",
              isScrolled ? "text-white hover:text-gray-300" : "text-black hover:text-black/70",
            )}
          >
            <HugeiconsIcon icon={GithubIcon} className="w-4 h-4" />
            <span>GitHub</span>
          </a>
          <Button
            as="a"
            href={LATEST_RELEASE_URL}
            target="_blank"
            rel="noreferrer"
            size="sm"
            className="hidden sm:inline-flex"
          >
            Download
          </Button>
          <button
            type="button"
            aria-expanded={menuOpen}
            aria-controls="mobile-nav"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            onClick={() => {
              if (menuOpen) closeMenu();
              else openMenu();
            }}
            className={cn(
              "md:hidden flex items-center justify-center w-10 h-10 rounded-full transition-[color,background-color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.97]",
              isScrolled
                ? "text-white hover:bg-white/10"
                : "text-black hover:bg-black/5",
            )}
          >
            <span
              className="t-icon-swap"
              data-state={menuOpen ? "b" : "a"}
            >
              <span className="t-icon" data-icon="a">
                <HugeiconsIcon icon={Menu01Icon} className="w-5 h-5" />
              </span>
              <span className="t-icon" data-icon="b">
                <HugeiconsIcon icon={Cancel01Icon} className="w-5 h-5" />
              </span>
            </span>
          </button>
        </div>
      </header>

      <div
        id="mobile-nav"
        className={cn(
          "fixed inset-0 z-40 md:hidden",
          menuOpen ? "pointer-events-auto" : "pointer-events-none",
        )}
        aria-hidden={!menuOpen}
      >
        <button
          type="button"
          aria-label="Close menu"
          onClick={closeMenu}
          className={cn(
            "absolute inset-0 bg-pitch-black/60 backdrop-blur-sm transition-opacity duration-200 ease-[var(--ease-out)]",
            menuOpen ? "opacity-100" : "opacity-0",
          )}
        />
        <nav
          className={cn(
            "t-dropdown absolute top-[72px] left-4 right-4 rounded-2xl border border-border-subtle bg-graphite/95 backdrop-blur-xl p-2 shadow-2xl shadow-pitch-black/50",
            menuPhase === "open" && "is-open",
            menuPhase === "closing" && "is-closing",
          )}
          data-origin="top-right"
        >
          {navLinks.map((link) => (
            <a
              key={link.label}
              href={link.href}
              target={link.external ? "_blank" : undefined}
              rel={link.external ? "noreferrer" : undefined}
              onClick={(event) => {
                if (link.external) {
                  closeMenu();
                  return;
                }
                handleAnchorClick(event, link.href);
              }}
              className="flex items-center justify-between rounded-xl px-4 py-3.5 text-base text-gray-200 transition-[color,background-color,transform] duration-150 ease-[var(--ease-out)] hover:bg-white/5 active:scale-[0.97]"
            >
              {link.label}
            </a>
          ))}
          <div className="mt-2 flex flex-col gap-2 border-t border-white/10 p-2 pt-4">
            <Button
              as="a"
              href={LATEST_RELEASE_URL}
              target="_blank"
              rel="noreferrer"
              size="md"
              className="w-full"
              onClick={closeMenu}
            >
              Download
            </Button>
            <Button
              as="a"
              href={GITHUB_REPO_URL}
              target="_blank"
              rel="noreferrer"
              variant="dark"
              size="md"
              className="w-full"
              onClick={closeMenu}
            >
              <HugeiconsIcon icon={GithubIcon} className="w-4 h-4" />
              GitHub
            </Button>
          </div>
        </nav>
      </div>
    </>
  );
};
