export type Testimonial = {
  quote: string;
  image: string;
  name: string;
  role: string;
  company?: string;
  href: string;
};

export const testimonials: Testimonial[] = [
  {
    quote:
      "Switching repos used to mean rebuilding my whole terminal layout. Termul keeps each project’s shells exactly where I left them.",
    image: 'https://github.com/shadcn.png',
    name: 'Alex Chen',
    role: 'Staff Engineer',
    company: 'Platform team',
    href: '#',
  },
  {
    quote:
      'Split panes plus a built-in browser for docs means I rarely alt-tab out of one window during deep work.',
    image: 'https://github.com/rauchg.png',
    name: 'Morgan Lee',
    role: 'Full-stack',
    company: 'Indie SaaS',
    href: '#',
  },
  {
    quote:
      "Session restore after a reboot is the feature I didn’t know I needed until I lost three terminals mid-deploy.",
    image: 'https://github.com/steven-tey.png',
    name: 'Jordan Kim',
    role: 'DevOps',
    company: 'Infra',
    href: '#',
  },
  {
    quote:
      'Project-scoped env vars land in every new shell automatically. No more copy-pasting from a stale .env.',
    image: 'https://unavatar.io/x/peer_rich',
    name: 'Sam Rivera',
    role: 'Backend',
    company: 'API squad',
    href: '#',
  },
  {
    quote:
      "The tabbed workspace feels closer to an IDE than a traditional terminal—and that’s a compliment.",
    image: 'https://github.com/serafimcloud.png',
    name: 'Riley Park',
    role: 'Tech lead',
    company: 'Mobile',
    href: '#',
  },
  {
    quote:
      'Annotations in the embedded browser saved our team hours when onboarding people to internal dashboards.',
    image: 'https://unavatar.io/x/sama',
    name: 'Casey Nguyen',
    role: 'Product engineer',
    company: 'Growth',
    href: '#',
  },
  {
    quote:
      'Cross-platform parity matters for us. Termul on macOS and Windows finally looks and behaves the same.',
    image: 'https://unavatar.io/x/sundarpichai',
    name: 'Drew Patel',
    role: 'Engineering manager',
    company: 'Distributed',
    href: '#',
  },
  {
    quote:
      'I run five services locally; named workspaces beat a folder of random iTerm profiles any day.',
    image: 'https://unavatar.io/x/tim_cook',
    name: 'Taylor Brooks',
    role: 'SRE',
    company: 'Reliability',
    href: '#',
  },
  {
    quote:
      "Lightweight Tauri app, native feel, and it doesn’t fight my GPU like some Electron terminals do.",
    image: 'https://unavatar.io/x/JeffBezos',
    name: 'Jamie Ortiz',
    role: 'Systems',
    company: 'Data',
    href: '#',
  },
  {
    quote:
      'Termul became the default launcher for every repo I touch. One place for shells, browser, and context.',
    image: 'https://unavatar.io/x/elonmusk',
    name: 'Quinn Walsh',
    role: 'Founder',
    company: 'Startup',
    href: '#',
  },
];
