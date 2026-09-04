import { useState } from 'react'
import { sampleCapture } from '@/api/mock'
import { DetailsPanel } from '@/components/DetailsPanel'
import { Graph } from '@/components/Graph'
import { Legend } from '@/components/Legend'
import { UploadButton } from '@/components/UploadButton'
import { formatCount } from '@/lib/format'
import type { CaptureDocument, Selection } from '@/types/graph'

export function App() {
  const [doc, setDoc] = useState<CaptureDocument>(sampleCapture)
  const [selection, setSelection] = useState<Selection>(null)

  const isSample = doc === sampleCapture

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
        </div>
        <UploadButton
          onDocument={loadDocument}
          canReset={!isSample}
          onReset={() => loadDocument(sampleCapture)}
        />
      </header>

      <main className="app-body">
        <div className="canvas">
          <Graph doc={doc} selection={selection} onSelect={setSelection} />
          <Legend />
        </div>
        <DetailsPanel doc={doc} selection={selection} onSelect={setSelection} />
      </main>
    </div>
  )
}
