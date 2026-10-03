import { motion } from 'framer-motion'
import { useLocation } from 'react-router-dom'
import { Button } from '@/components/ui/button'

const NotFound = () => {
  const location = useLocation()

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="text-center"
      >
        <h1 className="text-6xl font-bold text-primary mb-4 font-mono">404</h1>
        <p className="text-xl text-foreground mb-2">Page not found</p>
        <p className="text-muted-foreground mb-6 font-mono text-sm">{location.pathname}</p>
        <Button asChild>
          <a href="/">Return to Workspace</a>
        </Button>
      </motion.div>
    </div>
  )
}

export default NotFound
