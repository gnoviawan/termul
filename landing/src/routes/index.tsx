import type { RouteObject } from 'react-router';

import { App } from '../App';
import { HomePage } from './HomePage';
import { TestimonialListPage } from './TestimonialListPage';
import { TestimonialSubmitPage } from './TestimonialSubmitPage';

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
