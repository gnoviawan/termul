import {
  LegalLink,
  LegalList,
  LegalPage,
  LegalSection,
} from '../components/legal/LegalPage';
import { LEGAL_LAST_UPDATED } from '../lib/legal';
import { GITHUB_REPO_URL, ISSUES_URL, LICENSE_URL } from '../lib/links';

export function TermsPage() {
  return (
    <LegalPage
      title="Terms"
      description="Terms for using the Termul app and website: MIT license, no warranty, and testimonial submission terms."
      path="/terms/"
      lastUpdated={LEGAL_LAST_UPDATED}
    >
      <LegalSection title="The Termul app">
        <p>
          Termul is free software released under the{' '}
          <LegalLink href={LICENSE_URL}>MIT License</LegalLink>. The license
          text in the repository is the authoritative document; if anything on
          this page differs from it, the license wins. Source code is at{' '}
          <LegalLink href={GITHUB_REPO_URL}>github.com/gnoviawan/termul</LegalLink>.
        </p>
        <p>
          Termul is free to download and use. Nothing on this website asks for
          payment.
        </p>
      </LegalSection>

      <LegalSection title="No warranty">
        <p>
          The software is provided &quot;as is&quot;, without warranty of any
          kind, express or implied, including merchantability, fitness for a
          particular purpose, and non-infringement. The authors and copyright
          holders are not liable for any claim, damages, or other liability
          arising from the software or its use. This follows the MIT License.
        </p>
        <p>
          Termul can run terminals, edit files, run Git commands, and launch
          third-party AI coding agents that can run commands on your machine.
          You are responsible for what you run and for backing up your work.
        </p>
      </LegalSection>

      <LegalSection title="Testimonials">
        <p>By submitting a testimonial on this website, you confirm that:</p>
        <LegalList>
          <li>The words are yours, and what you wrote is true to your experience.</li>
          <li>
            You have the right to use the avatar image or avatar URL you
            provide.
          </li>
          <li>
            You agree that your quote, name, role, and avatar may be shown
            publicly on termul.dev if the maintainer approves it. Submissions
            are reviewed first and may be rejected or unpublished at any time
            without a reason.
          </li>
        </LegalList>
        <p>
          You can ask for removal at any time by opening an issue at{' '}
          <LegalLink href={ISSUES_URL}>{ISSUES_URL.replace('https://', '')}</LegalLink>{' '}
          and saying which testimonial it is. Do not post anything private in
          the issue. Removal from the site is manual. Copies already cached by
          others (for example search engines) are outside our control. See
          the <a className="text-foreground underline underline-offset-4" href="/privacy/">Privacy</a>{' '}
          page for what is stored.
        </p>
      </LegalSection>

      <LegalSection title="Website use">
        <p>
          Please do not abuse the testimonial form (spam, automated
          submissions, or content that is unlawful or infringes others&apos;
          rights). Submissions are rate limited.
        </p>
      </LegalSection>

      <LegalSection title="Contact">
        <p>
          The only contact channel we list is the GitHub project:{' '}
          <LegalLink href={ISSUES_URL}>{ISSUES_URL.replace('https://', '')}</LegalLink>.
          Private vulnerability reporting is not enabled on the repository at
          the time of writing, so do not post security details in a public
          issue; ask there for a private way to reach a maintainer.
        </p>
      </LegalSection>

      <LegalSection title="Changes">
        <p>
          These terms live in the open-source repository. Changes are made by
          pull request and the date above is updated.
        </p>
        <p>
          <em>Ringkasan:</em> Termul gratis dan berlisensi MIT, diberikan apa
          adanya tanpa garansi. Dengan mengirim testimoni, kamu setuju
          kutipan, nama, peran, dan avatar ditampilkan di termul.dev setelah
          disetujui, dan bisa minta dihapus lewat issue GitHub.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
