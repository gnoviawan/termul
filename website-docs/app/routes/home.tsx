import { HomeLayout } from 'fumadocs-ui/layouts/home'
import { Link } from 'react-router'
import { baseOptions } from '@/lib/layout.shared'
import type { Route } from './+types/home'

export function meta(_args: Route.MetaArgs) {
  return [
    { title: 'Termul Documentation' },
    {
      name: 'description',
      content: 'Install Termul and set up your first project workspace.'
    }
  ]
}

export default function Home() {
  return (
    <HomeLayout {...baseOptions()}>
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center px-6 py-24 text-center">
        <p className="mb-4 text-sm font-medium text-fd-muted-foreground">Termul documentation</p>
        <h1 className="mb-4 text-4xl font-bold tracking-tight sm:text-5xl">
          Get more from every workspace.
        </h1>
        <p className="mb-8 max-w-2xl text-lg text-fd-muted-foreground">
          Install Termul, create a project workspace, and keep your terminals organized.
        </p>
        <Link
          className="rounded-full bg-fd-primary px-5 py-3 text-sm font-medium text-fd-primary-foreground"
          to="/docs"
        >
          Read the installation guide
        </Link>
      </main>
    </HomeLayout>
  )
}
