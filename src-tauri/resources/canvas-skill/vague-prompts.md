# Vague prompts

Most requests are a few words: "landing page toko roti", "dashboard gym", "poster instagram promo kopi". Treat the missing details as your job, not the user's. Fill them in with confident, specific choices, build, and show the result.

## The playbook

### 1. Infer the artifact and the audience

Read the words for the artifact type, then pick its default size from the domain guide.

| The prompt says | Build | Guide |
| --- | --- | --- |
| landing page, website, homepage, halaman, situs, profil (company, school, shop) | A desktop web page, 1440 wide | `landing-page` |
| portfolio, portofolio | A desktop web page that leads with the work | `landing-page` |
| pricing page, harga, paket | A desktop web page centred on the plans | `landing-page` |
| app, aplikasi, screen, layar, login, sign up, daftar, onboarding | Phone screens, 393 × 852 (`iPhone 16`) | `mobile-app` |
| admin, CMS, settings, web app, panel | A desktop app screen, 1440 × 1024 | `web-app` |
| dashboard, laporan, statistik, analytics | A desktop dashboard, 1440 × 1024 | `dashboard` |
| slide, deck, presentasi, pitch | 16:9 slides, 1920 × 1080, one frame each | `slides` |
| poster, post, feed, story, banner, flyer, promo, thumbnail | A social format; Instagram post 1080 × 1350 by default | `social-post` |
| design system, UI kit, komponen, style guide | Tokens and components on their own frames | `design-system` |

When the type is still unclear, build the most likely one. "Toko roti" with nothing else is a landing page; "kopi promo" is a social post.

Then name the audience: who would look at this, and what one thing should they do? For a bakery page it is a local customer who should order or visit; for a gym dashboard it is the owner who should see this month's members and revenue.

### 2. Pick a style and say which

If the user names no brand, colours or mood, call `get_canvas_style()` and choose the style whose `bestFor` fits the subject. Tell the user in one line, for example: "I used the Warm Editorial style: cream, cocoa and terracotta, like a bakery menu."

If the user gives a brand colour, still start from the closest style and replace its `primary` (and `onPrimary` if contrast needs it).

### 3. Write real copy in the user's language

- Reply and write the design in the language of the prompt. An Indonesian prompt gets Indonesian copy, including buttons and labels; mixed prompts follow the language of the subject words.
- Invent a plausible, specific subject: a name ("Toko Roti Sari", "Iron Haven Gym"), a place, opening hours, products with prices in the local currency (Rp 18.000, not $5), a phone or WhatsApp line in a plausible local format.
- Write headlines that say what changes for the reader, not what the product has. "Sarapan hangat tanpa antre" beats "Roti berkualitas tinggi".
- Keep numbers believable: a neighbourhood bakery has dozens of reviews, not millions of users.
- Never use lorem ipsum, "Your headline here", "Company Name" or "Feature 1".

### 4. Build, then show

Follow `working-protocol`: tokens, root frame, one section per call, a check after each. Build the whole artifact before you ask for feedback. A finished first version with sensible choices is more useful than a list of questions.

When you finish, say in two or three lines what you made, the style and the invented details the user may want to replace (the shop name, the prices), and offer one or two next steps.

### 5. Ask at most one question, and only when you must

Ask only when any guess would make the result useless, for example "translate my menu" with no menu, or "redesign our logo" with no name. In every other case, decide, build and say what you decided.

## Defaults when nothing is said

- Light mode, unless the style says to prefer dark or the subject is nightlife, gaming or sport.
- One page or screen. For an app, the single most important screen; for a deck, the number of slides asked for, or five.
- Desktop for websites, phone for apps.
- Content for a real first visit: a hero, three to five sections, and a clear call to action.
