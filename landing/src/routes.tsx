import type { RouteObject } from 'react-router';

import { App } from './App';
import { HomePage } from './pages/HomePage';
import { TestimonialListPage } from './pages/TestimonialListPage';
import { TestimonialSubmitPage } from './pages/TestimonialSubmitPage';

export const routes: RouteObject[] = [
  {
    path: '/',
    Component: App,
    children: [
      {
        index: true,
        Component: HomePage,
      },
      {
        path: 'testimonial/submit',
        Component: TestimonialSubmitPage,
      },
      {
        path: 'testimonial/list',
        Component: TestimonialListPage,
      },
    ],
  },
];
