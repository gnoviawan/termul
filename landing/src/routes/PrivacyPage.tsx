import {
  LegalLink,
  LegalList,
  LegalPage,
  LegalSection,
} from '../components/legal/LegalPage';
import { LEGAL_LAST_UPDATED } from '../lib/legal';
import { GITHUB_REPO_URL, ISSUES_URL } from '../lib/links';

export function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy"
      description="What the Termul website collects and loads, and what is and is not known about the Termul desktop app."
      path="/privacy/"
      lastUpdated={LEGAL_LAST_UPDATED}
    >
      <LegalSection title="Summary">
        <p>
          Termul is a free, open-source desktop app. This website (termul.dev)
          loads Google Tag Manager, may load Cloudflare Web Analytics, and
          stores testimonial submissions. We did not find analytics or crash
          reporting code in the desktop app source. Details below.
        </p>
        <p>
          <em>Ringkasan:</em> situs ini memakai Google Tag Manager dan
          menyimpan testimoni yang dikirim lewat formulir. Di source aplikasi
          desktop kami tidak menemukan kode analytics atau crash reporting.
        </p>
      </LegalSection>

      <LegalSection title="Website: analytics and third-party requests">
        <LegalList>
          <li>
            <strong>Google Tag Manager</strong> (container{' '}
            <code>GTM-M7G7GR3C</code>) is loaded on every page. What it
            collects depends on the tags configured inside that container,
            which is not visible in this repository. Google Analytics domains
            are allowed by the site&apos;s Content Security Policy, but we
            have not verified which tags actually run.
          </li>
          <li>
            <strong>Cloudflare Web Analytics</strong>: the Content Security
            Policy allows the Cloudflare Insights script and endpoint. Whether
            it is turned on for termul.dev is a dashboard setting we have not
            verified.
          </li>
          <li>
            <strong>Google Fonts</strong> (fonts.googleapis.com and
            fonts.gstatic.com) are loaded for the Inter and JetBrains Mono
            fonts. Your browser sends a request, including your IP address, to
            Google.
          </li>
          <li>
            <strong>Images</strong> for contributors and testimonials may be
            loaded from GitHub and unavatar.io. A demo video is loaded from
            CloudFront.
          </li>
          <li>
            <strong>DiceBear avatars</strong>: when a testimonial has no avatar
            image, the browser computes a SHA-256 hash of the displayed name
            and requests a generated avatar from api.dicebear.com using only
            that hash as the seed. The raw name is not sent. If hashing is not
            available, local initials are shown instead.
          </li>
          <li>
            The site sets the <code>Referrer-Policy: no-referrer</code>{' '}
            header.
          </li>
          <li>
            The site does not currently show a cookie consent banner.
          </li>
        </LegalList>
      </LegalSection>

      <LegalSection title="Website: testimonial form">
        <p>If you submit a testimonial at /testimonial/submit, we store:</p>
        <LegalList>
          <li>Your quote, name, and role, as you typed them.</li>
          <li>
            An avatar: either an uploaded image (PNG, JPEG, GIF, or WebP, up to
            2 MB) stored in a Cloudflare R2 bucket, or an avatar URL you
            provide.
          </li>
          <li>The submission time and a moderation status (pending, approved, or rejected).</li>
        </LegalList>
        <p>
          Data is stored in Cloudflare D1 (database) and R2 (uploaded avatars).
          Submissions are reviewed before they appear publicly; pending and
          rejected ones are only visible to the maintainer through a
          token-protected moderation page.
        </p>
        <p>
          To limit spam, the form handler hashes your IP address with SHA-256
          and keeps the hash with a timestamp in a rate-limit table (limit: 5
          submissions per hour). Rows older than one hour are deleted when a
          new submission is checked. The raw IP address is not stored by this
          code. The hash is not salted.
        </p>
      </LegalSection>

      <LegalSection title="Hosting">
        <p>
          The site and its API appear to be built for Cloudflare Pages
          (Pages Functions, D1, R2). Cloudflare, as host, may process
          request logs such as IP addresses under its own policy. We did not
          verify the production hosting configuration beyond the repository.
        </p>
      </LegalSection>

      <LegalSection title="Desktop app">
        <LegalList>
          <li>
            In the app source (<LegalLink href={GITHUB_REPO_URL}>
              github.com/gnoviawan/termul
            </LegalLink>) we did not find analytics, telemetry, or crash
            reporting libraries.
          </li>
          <li>
            The app includes the Tauri updater, configured to read{' '}
            <code>latest.json</code> from the project&apos;s GitHub releases.
            Checking for updates therefore contacts GitHub. The app also reads
            release notes from api.github.com. Exactly when automatic checks
            run was not verified.
          </li>
          <li>
            Your terminals, files, and projects stay on your machine. If you
            use features that connect elsewhere (AI coding agents, MCP
            servers, SSH, a browser pane, or termul-server), the data you send
            goes to the service you chose, under that service&apos;s own
            policy. We did not audit each of these integrations for this page.
          </li>
        </LegalList>
      </LegalSection>

      <LegalSection title="Removal and questions">
        <p>
          To ask for your testimonial to be removed, or to ask any privacy
          question, open an issue at{' '}
          <LegalLink href={ISSUES_URL}>{ISSUES_URL.replace('https://', '')}</LegalLink>.
          Please do not post private information in a public issue; say that
          you want to be contacted privately and a maintainer will reply on
          the issue. There is no dedicated privacy email address.
        </p>
      </LegalSection>

      <LegalSection title="Changes">
        <p>
          This page lives in the open-source repository. Changes are made by
          pull request and the date above is updated.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
