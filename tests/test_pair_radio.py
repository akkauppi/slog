import json
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).parents[1] / "tools"))
import pair_radio

class PairingTests(unittest.TestCase):
    def test_private_matching_configs_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            output=Path(directory)/"pair"
            pair_radio.prepare("020000000001","020000000002",6,output)
            kit=json.loads((output/"pairing-kit.json").read_text())
            self.assertEqual(kit["schema"],"saunan.pairing-kit.v1")
            self.assertEqual(kit["logger"],json.loads((output/"logger.json").read_text()))
            self.assertEqual(kit["receiver"],json.loads((output/"receiver.json").read_text()))
            self.assertEqual((output/"pairing-kit.json").stat().st_mode & 0o777,0o600)
            lm,logger=pair_radio.load_pairing(output/"logger.json")
            rm,receiver=pair_radio.load_pairing(output/"receiver.json")
            self.assertEqual(logger[24:56],receiver[24:56])
            self.assertEqual(logger[8:16],receiver[8:16])
            self.assertEqual(logger[16:22].hex().upper(),rm)
            self.assertEqual(receiver[16:22].hex().upper(),lm)
            self.assertEqual((output/"logger.json").stat().st_mode & 0o777,0o600)
            with self.assertRaises(FileExistsError):
                pair_radio.prepare(lm,rm,6,output)
            doc=json.loads((output/"logger.json").read_text())
            doc["target_mac"]=rm
            (output/"logger.json").write_text(json.dumps(doc))
            with self.assertRaises(ValueError): pair_radio.load_pairing(output/"logger.json")
    def test_invalid_channels_and_mac(self):
        for mac in ["FFFFFFFFFFFF","000000000000","short","010000000001"]:
            with self.assertRaises(ValueError): pair_radio.mac_bytes(mac)
        with tempfile.TemporaryDirectory() as directory:
            for channel in [0,12,255]:
                with self.assertRaises(ValueError): pair_radio.prepare("020000000001","020000000002",channel,Path(directory)/"pair")
