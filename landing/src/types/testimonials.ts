export type TestimonialStatus = 'pending' | 'approved' | 'rejected';

export type PublicTestimonial = {
  id: string;
  quote: string;
  name: string;
  role: string;
  image: string;
  href: string;
};

export type AdminTestimonial = PublicTestimonial & {
  status: TestimonialStatus;
  avatarKind: 'r2' | 'url' | 'none';
  createdAt: string;
  updatedAt: string;
};

export type TestimonialSubmitResponse = {
  id: string;
  status: 'pending';
};
