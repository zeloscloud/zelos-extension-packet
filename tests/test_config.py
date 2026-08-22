"""Config parsing and schema-default application.

The schema defaults and `parse_interfaces` defaults are asserted separately and
then checked against each other, because CLI callers never go through
`load_config` and the two must not drift.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from zelos_sdk.extensions import load_config

from zelos_extension_packet.capture import (
    DEFAULT_BUFFER_SIZE,
    DEFAULT_SNAPLEN,
    ConfigError,
    parse_interfaces,
    sanitize_capture_name,
)

REPO_ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATH = REPO_ROOT / "config.schema.json"


def load(tmp_path: Path, raw: dict) -> dict:
    config_file = tmp_path / "config.json"
    config_file.write_text(json.dumps(raw))
    return load_config(config_path=config_file, schema_path=SCHEMA_PATH)


class TestSchemaDefaults:
    def test_empty_config_gets_every_top_level_default(self, tmp_path: Path):
        config = load(tmp_path, {})
        assert config["exclude_agent_traffic"] is True
        assert config["log_frames"] is True
        assert config["log_level"] == "INFO"
        assert config["interfaces"] == []

    def test_exclude_agent_traffic_defaults_true(self, tmp_path: Path):
        # The single most consequential default: without it, publishing a
        # captured packet is itself captured and the loop amplifies.
        assert (
            load(tmp_path, {"interfaces": [{"interface": "en0"}]})["exclude_agent_traffic"] is True
        )

    def test_exclude_agent_traffic_can_be_turned_off(self, tmp_path: Path):
        config = load(tmp_path, {"exclude_agent_traffic": False})
        assert config["exclude_agent_traffic"] is False

    def test_interface_item_defaults(self, tmp_path: Path):
        config = load(tmp_path, {"interfaces": [{"interface": "eth0"}]})
        entry = config["interfaces"][0]
        assert entry["snaplen"] == 512
        assert entry["promiscuous"] is False
        assert entry["buffer_size"] == 8 * 1024 * 1024

    def test_replay_pcap_is_optional_and_absent_by_default(self, tmp_path: Path):
        assert not load(tmp_path, {}).get("replay_pcap")

    def test_shipped_config_json_validates(self, tmp_path: Path):
        shipped = json.loads((REPO_ROOT / "config.json").read_text())
        config = load(tmp_path, shipped)
        assert config["exclude_agent_traffic"] is True

    def test_snaplen_below_minimum_is_rejected(self, tmp_path: Path):
        with pytest.raises(Exception) as excinfo:
            load(tmp_path, {"interfaces": [{"interface": "eth0", "snaplen": 8}]})
        assert "snaplen" in str(excinfo.value)


class TestParseInterfaces:
    def test_defaults_match_the_schema(self):
        [cfg] = parse_interfaces({"interfaces": [{"interface": "eth0"}]})
        assert cfg.snaplen == DEFAULT_SNAPLEN == 512
        assert cfg.promiscuous is False
        assert cfg.buffer_size == DEFAULT_BUFFER_SIZE == 8 * 1024 * 1024

    def test_name_defaults_to_interface(self):
        [cfg] = parse_interfaces({"interfaces": [{"interface": "eth0"}]})
        assert cfg.name == "eth0"

    def test_explicit_name_wins(self):
        [cfg] = parse_interfaces({"interfaces": [{"interface": "eth0", "name": "uplink"}]})
        assert cfg.name == "uplink"

    def test_blank_name_falls_back_to_interface(self):
        [cfg] = parse_interfaces({"interfaces": [{"interface": "eth0", "name": "   "}]})
        assert cfg.name == "eth0"

    def test_vlan_interface_name_is_sanitized(self):
        # `eth0.100` is a real VLAN interface name and `.` is a catalog path
        # separator, so the capture name must not carry it through.
        [cfg] = parse_interfaces({"interfaces": [{"interface": "eth0.100"}]})
        assert cfg.interface == "eth0.100"
        assert cfg.name == "eth0_100"

    def test_missing_interface_is_an_error(self):
        with pytest.raises(ConfigError, match="missing 'interface'"):
            parse_interfaces({"interfaces": [{"name": "nope"}]})

    def test_duplicate_capture_names_are_a_hard_error(self):
        with pytest.raises(ConfigError, match="Duplicate capture name"):
            parse_interfaces(
                {
                    "interfaces": [
                        {"interface": "eth0", "name": "wan"},
                        {"interface": "eth1", "name": "wan"},
                    ]
                }
            )

    def test_names_that_collide_only_after_sanitizing_are_still_caught(self):
        with pytest.raises(ConfigError, match="Duplicate capture name"):
            parse_interfaces({"interfaces": [{"interface": "eth0.1"}, {"interface": "eth0:1"}]})

    def test_missing_interfaces_key_is_empty(self):
        assert parse_interfaces({}) == []


class TestSanitizeCaptureName:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("eth0", "eth0"),
            ("eth0.100", "eth0_100"),
            ("user@host:iface", "user_host_iface"),
            ("  en0  ", "en0"),
            ("a/b", "a_b"),
            ("...", "capture"),
        ],
    )
    def test_path_separators_collapse(self, raw: str, expected: str):
        assert sanitize_capture_name(raw) == expected
