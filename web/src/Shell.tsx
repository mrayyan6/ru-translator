import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import Translator from './Translator';
import Diagnostics from './App';

/**
 * Two views over the same engines: the translator people actually use, and the
 * Phase 0 harness that produces the evidence.
 *
 * The harness stays in the build on purpose — until Airplane Mode has been
 * proven on both phones it is the more important of the two, and it costs
 * nothing to keep behind a button.
 */
export default function Shell() {
  const [view, setView] = useState<'translate' | 'diagnostics'>('translate');
  const reduce = useReducedMotion();

  return (
    <AnimatePresence mode="wait" initial={false}>
      {view === 'translate' ? (
        <motion.div
          key="translate"
          initial={reduce ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={reduce ? undefined : { opacity: 0 }}
          transition={{ duration: 0.16 }}
        >
          <Translator onOpenDiagnostics={() => setView('diagnostics')} />
        </motion.div>
      ) : (
        <motion.div
          key="diagnostics"
          initial={reduce ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={reduce ? undefined : { opacity: 0 }}
          transition={{ duration: 0.16 }}
        >
          <button className="t-back-btn" onClick={() => setView('translate')}>
            ← Back to translator
          </button>
          <Diagnostics />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
