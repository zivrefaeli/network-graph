"""Route behaviour, through TestClient.

The end-to-end cases need tshark and run in the container. The ones that do not
-- error mapping, the store, the response contract -- run anywhere.
"""

import io
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.schemas.graph import CaptureDocument
from app.store import CaptureStore


class TestHealth:
    def test_reports_liveness_and_whether_tshark_is_there(self, client: TestClient) -> None:
        response = client.get("/health")
        assert response.status_code == 200
        body = response.json()
        assert body["status"] in {"ok", "degraded"}
        assert isinstance(body["tshark_available"], bool)

    def test_stays_up_when_tshark_is_missing(self, client: TestClient) -> None:
        # A connection error is indistinguishable from the server being down.
        # Saying "degraded, and here is why" is far more useful to a frontend.
        response = client.get("/health")
        assert response.status_code == 200
        body = response.json()
        if not body["tshark_available"]:
            assert body["status"] == "degraded"
            assert body["tshark_error"]

    def test_the_response_has_no_undeclared_fields(self, client: TestClient) -> None:
        assert set(client.get("/health").json()) == {
            "status",
            "tshark_available",
            "tshark_version",
            "tshark_error",
            "captures_held",
        }


class TestUploadValidation:
    def test_an_empty_file_is_422_with_a_reason(self, client: TestClient) -> None:
        response = client.post(
            "/captures",
            files={"file": ("empty.pcapng", io.BytesIO(b""), "application/octet-stream")},
        )
        assert response.status_code == 422
        assert "empty" in response.json()["detail"]

    def test_a_missing_file_field_is_rejected(self, client: TestClient) -> None:
        assert client.post("/captures").status_code == 422

    @pytest.mark.tshark
    def test_a_file_that_is_not_a_capture_is_500_not_a_crash(self, client: TestClient) -> None:
        response = client.post(
            "/captures",
            files={"file": ("notes.txt", io.BytesIO(b"just some text" * 100), "text/plain")},
        )
        assert response.status_code == 500
        # tshark's own stderr can name server paths, so it is logged rather
        # than returned.
        assert "server log" in response.json()["detail"]


class TestMissingCapture:
    def test_an_unknown_id_is_404(self, client: TestClient) -> None:
        assert client.get("/captures/cap_nope").status_code == 404

    def test_the_404_explains_that_the_store_is_not_persistence(self, client: TestClient) -> None:
        detail = client.get("/captures/cap_nope").json()["detail"]
        assert "restarted" in detail


@pytest.mark.tshark
class TestRoundTrip:
    def test_uploading_a_capture_returns_a_valid_document(
        self, client: TestClient, tiny_capture: Path
    ) -> None:
        response = client.post(
            "/captures",
            files={"file": ("tiny.pcapng", tiny_capture.read_bytes(), "application/octet-stream")},
        )
        assert response.status_code == 201, response.text
        # Validates against the models the frontend's types mirror.
        document = CaptureDocument.model_validate(response.json())
        assert document.schema_version == "2.0"
        assert document.capture.filename == "tiny.pcapng"
        assert document.capture.packets_total == 31
        assert document.machines and document.nodes and document.edges

    def test_the_document_can_be_read_back_by_id(
        self, client: TestClient, tiny_capture: Path
    ) -> None:
        created = client.post(
            "/captures",
            files={"file": ("tiny.pcapng", tiny_capture.read_bytes(), "application/octet-stream")},
        ).json()
        fetched = client.get(f"/captures/{created['capture']['id']}")
        assert fetched.status_code == 200
        assert fetched.json() == created

    def test_the_capture_id_is_not_guessable(self, client: TestClient, tiny_capture: Path) -> None:
        # One client must not be able to enumerate another's uploads.
        ids = {
            client.post(
                "/captures",
                files={"file": ("t.pcapng", tiny_capture.read_bytes(), "application/octet-stream")},
            ).json()["capture"]["id"]
            for _ in range(3)
        }
        assert len(ids) == 3
        assert all(len(capture_id) > 10 for capture_id in ids)

    def test_the_sha256_is_of_the_bytes_uploaded(
        self, client: TestClient, tiny_capture: Path
    ) -> None:
        import hashlib

        payload = tiny_capture.read_bytes()
        body = client.post(
            "/captures",
            files={"file": ("tiny.pcapng", payload, "application/octet-stream")},
        ).json()
        assert body["capture"]["sha256"] == hashlib.sha256(payload).hexdigest()

    def test_nanoseconds_reach_the_wire(self, client: TestClient, tiny_capture: Path) -> None:
        body = client.post(
            "/captures",
            files={"file": ("tiny.pcapng", tiny_capture.read_bytes(), "application/octet-stream")},
        ).json()
        # Serialised as a string, at the capture's own resolution -- a datetime
        # would have rounded three digits off on the way through.
        assert body["capture"]["started_at"].endswith("789Z")

    def test_no_l3_edge_terminates_on_a_mac(self, client: TestClient, tiny_capture: Path) -> None:
        body = client.post(
            "/captures",
            files={"file": ("tiny.pcapng", tiny_capture.read_bytes(), "application/octet-stream")},
        ).json()
        for edge in body["edges"]:
            if edge["layer"] == "l3":
                assert all(end.startswith("ip:") for end in edge["endpoints"]), edge["id"]

    def test_a_scan_comes_out_flagged(self, client: TestClient, scan_capture: Path) -> None:
        body = client.post(
            "/captures",
            files={"file": ("scan.pcapng", scan_capture.read_bytes(), "application/octet-stream")},
        ).json()
        l3 = [edge for edge in body["edges"] if edge["layer"] == "l3"]
        assert len(l3) == 1
        health = l3[0]["properties"]["tcp_health"]
        assert health["syn_count"] > 0
        assert health["syn_ack_count"] == 0
        assert health["failed_handshakes"] == health["syn_count"]

    def test_both_rollup_invariants_hold_over_the_fixture(
        self, client: TestClient, tiny_capture: Path
    ) -> None:
        body = client.post(
            "/captures",
            files={"file": ("tiny.pcapng", tiny_capture.read_bytes(), "application/octet-stream")},
        ).json()
        by_id = {node["id"]: node for node in body["nodes"]}

        for node in body["nodes"]:
            sent = received = 0
            for edge in body["edges"]:
                if edge["layer"] != "l3" or node["id"] not in edge["endpoints"]:
                    continue
                outbound = edge["endpoints"][0] == node["id"]
                mine = edge["properties"]["forward" if outbound else "reverse"]
                theirs = edge["properties"]["reverse" if outbound else "forward"]
                sent += mine["frame_bytes"]
                received += theirs["frame_bytes"]
            assert node["properties"]["traffic"]["frame_bytes_sent"] == sent, node["id"]
            assert node["properties"]["traffic"]["frame_bytes_received"] == received, node["id"]

        for machine in body["machines"]:
            expected = sum(
                by_id[node_id]["properties"]["traffic"]["frame_bytes_sent"]
                for node_id in machine["node_ids"]
            )
            assert machine["properties"]["traffic"]["frame_bytes_sent"] == expected, machine["id"]

    def test_every_edge_endpoint_is_in_the_document(
        self, client: TestClient, tiny_capture: Path
    ) -> None:
        body = client.post(
            "/captures",
            files={"file": ("tiny.pcapng", tiny_capture.read_bytes(), "application/octet-stream")},
        ).json()
        known = {node["id"] for node in body["nodes"]} | {m["id"] for m in body["machines"]}
        for edge in body["edges"]:
            for endpoint in edge["endpoints"]:
                assert endpoint in known, f"{edge['id']} points at {endpoint}"


class TestStore:
    def test_holds_and_returns_a_document(self) -> None:
        store = CaptureStore()
        assert store.get("cap_missing") is None
        assert len(store) == 0

    def test_drops_the_oldest_once_full(self) -> None:
        # Documents are large and aggregation runs per upload; without a cap a
        # long-running server accumulates every one it has ever produced.
        from app.aggregation.build import CaptureMeta, build_document
        from tests.test_aggregation import META, Clock, ip_packet

        store = CaptureStore(capacity=2)
        ids = []
        for index in range(3):
            clock = Clock()
            meta = CaptureMeta(id=f"cap_{index}", filename=META.filename, sha256=META.sha256)
            document = build_document(
                [
                    ip_packet(
                        clock,
                        eth_src="00:1a:2b:3c:4d:5e",
                        eth_dst="00:11:32:8a:c4:7d",
                        ip_src="10.20.30.50",
                        ip_dst="10.20.30.20",
                    )
                ],
                meta,
            )
            store.put(document)
            ids.append(document.capture.id)

        assert len(store) == 2
        assert store.get(ids[0]) is None
        assert store.get(ids[1]) is not None
        assert store.get(ids[2]) is not None
