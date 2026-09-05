import { useState } from 'react'
import { sampleCapture } from '@/api/mock'
import { DetailsPanel } from '@/components/DetailsPanel'
import { Graph } from '@/components/Graph'
import { HealthStrip } from '@/components/HealthStrip'
import { Legend } from '@/components/Legend'
import { UploadButton } from '@/components/UploadButton'
import { useHealth } from '@/hooks/useHealth'
import { formatCount } from '@/lib/format'
import type { CaptureDocument, Selection } from '@/types/graph'

export function App() {
  const [doc, setDoc] = useState<CaptureDocument>(sampleCapture)
  const [selection, setSelection] = useState<Selection>(null)
  const { state: health, recheck } = useHealth()

  const isSample = doc === sampleCapture
  // Only a backend that answered *and* has a dissector can take a capture.
  // Anything else and the button says so rather than failing mid-upload.
  const captureUploadAvailable = health.kind === 'ready' && health.health.tshark_available

  // Selection lives here and is passed down; no component holds its own idea
  // of what is selected. A new document invalidates every id in the old one.
  const loadDocument = (next: CaptureDocument): void => {
    setDoc(next)
    setSelection(null)
  }

  return (
    <div className="app">
      <header className="app-head">
        <div className="app-title">
          <h1>Network Graph</h1>
          <p className="capture-line">
            <code>{doc.capture.filename}</code>
            <span className="dot" />
            {formatCount(doc.capture.packets_total)} packets
            <span className="dot" />
            {doc.machines.length} machines
            <span className="dot" />
            {doc.nodes.length} addresses
            <span className="dot" />
            {doc.edges.length} conversations
            {isSample && <span className="tag">sample</span>}
          </p>
          <HealthStrip state={health} onRecheck={recheck} />
        </div>
        <UploadButton
          onDocument={loadDocument}
          canReset={!isSample}
          onReset={() => loadDocument(sampleCapture)}
          captureUploadAvailable={captureUploadAvailable}
        />
      </header>

      <main className="app-body">
        <div className="canvas">
          <Graph doc={doc} selection={selection} onSelect={setSelection} />
          <Legend />
        </div>
        {/* No selection, no panel: the canvas takes the width back rather than
            spending it on a paragraph explaining that nothing is selected. */}
        {selection !== null && (
          <DetailsPanel doc={doc} selection={selection} onSelect={setSelection} />
        )}
      </main>
    </div>
  )
}
