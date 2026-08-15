import { motion } from 'framer-motion'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'react-router-dom'

const NotFound = () => {
  const { t } = useTranslation('shell')
  const location = useLocation()

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="text-center"
      >
        <h1 className="text-6xl font-bold text-primary mb-4 font-mono">404</h1>
        <p className="text-xl text-foreground mb-2">{t('notFound.title')}</p>
        <p className="text-muted-foreground mb-6 font-mono text-sm">{location.pathname}</p>
        <a
          href="/"
          className="inline-flex items-center px-4 py-2 bg-primary text-primary-foreground rounded hover:bg-primary/90 transition-colors font-medium"
        >
          {t('notFound.return')}
        </a>
      </motion.div>
    </div>
  )
}

export default NotFound
