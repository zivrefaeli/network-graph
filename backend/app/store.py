"""Where a parsed document lives between the upload and a later GET.

This is a dictionary in the server process, and saying so plainly is the point:
it is not persistence. Restart the process and every capture is gone, and a
second worker knows nothing about the first one's uploads. ``GET /captures/{id}``
needs somewhere to read from, and pretending a dict is a database is the failure
mode worth avoiding.

Replacing it means giving the document a real home -- a file next to the
capture, SQLite, object storage -- and this module is deliberately the only
thing that would have to change.
"""

from collections import OrderedDict
from threading import Lock

from app.schemas.graph import CaptureDocument


class CaptureStore:
    """A bounded, thread-safe map of capture id to document.

    Bounded because aggregation runs in a worker thread and the results are
    large: without a cap, a long-running server accumulates every document it
    has ever produced. The oldest is dropped first.

    Locked because ``asyncio.to_thread`` means writes genuinely arrive from
    more than one thread.
    """

    def __init__(self, *, capacity: int = 32) -> None:
        self._capacity = capacity
        self._lock = Lock()
        self._documents: OrderedDict[str, CaptureDocument] = OrderedDict()

    def put(self, document: CaptureDocument) -> None:
        with self._lock:
            self._documents[document.capture.id] = document
            self._documents.move_to_end(document.capture.id)
            while len(self._documents) > self._capacity:
                self._documents.popitem(last=False)

    def get(self, capture_id: str) -> CaptureDocument | None:
        with self._lock:
            document = self._documents.get(capture_id)
            if document is not None:
                self._documents.move_to_end(capture_id)
            return document

    def __len__(self) -> int:
        with self._lock:
            return len(self._documents)
