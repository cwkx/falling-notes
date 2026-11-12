#!/usr/bin/env python3
"""Apply the checked Godowsky markings without reserializing the original XML."""

import argparse
from fractions import Fraction
import hashlib
from html import escape
import json
from pathlib import Path
import re
import tempfile
import xml.etree.ElementTree as ET
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
SCORE = ROOT / "prelude-in-c-sharp-minor-opus-3-no-2-sergei-rachmaninoff.mxl"
DATA = ROOT / "data/rachmaninoff-fingerings.json"
STEPS = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
NOTE = re.compile(r"<note\b[^>]*>.*?</note>", re.S)
FINGER = r"<fingering>[1-5]</fingering>"
FIELD = r'<miscellaneous-field name="fingering-source">[^<]*</miscellaneous-field>'


def unannotate(xml):
    # These are the exact compact wrappers inserted below. Existing whitespace,
    # engraving, note data, and unrelated notation are left byte-for-byte intact.
    for pattern in [f"<notations><technical>{FINGER}</technical></notations>",
                    f"<technical>{FINGER}</technical>", FINGER,
                    f"<miscellaneous>{FIELD}</miscellaneous>", FIELD]:
        xml = re.sub(pattern, "", xml)
    return xml


def marking_key(mark):
    return (mark["measure"], mark["staff"], mark["midi"],
            Fraction(mark["offset"], mark["divisions"]))


def source_field(data):
    source = data["source"]
    pages = ", ".join(str(page["pdf"]) for page in source["pages"])
    credit = (f'{source["editor"]}, {source["publisher"]}, {source["year"]}; '
              f'PDF pages {pages}; selected printed fingerings. {source["url"]}')
    return f'<miscellaneous-field name="fingering-source">{escape(credit)}</miscellaneous-field>'


def annotate(xml, data):
    original = unannotate(xml)
    digest = hashlib.sha256(original.encode("utf-8")).hexdigest()
    if digest not in (data["originalScoreSha256"], data["unannotatedScoreSha256"]):
        raise ValueError("Score differs from the checked source beyond the inserted annotations")
    # Remove only the old export's eight nameless empty positioning tags.
    # They contain no musical data and otherwise make the download invalid XML.
    original = re.sub(r'<\s+(?:default-[xy]="[^"]*"\s*)+/>', "", original)
    if hashlib.sha256(original.encode("utf-8")).hexdigest() != data["unannotatedScoreSha256"]:
        raise ValueError("Score does not match the checked, cleaned source")

    markings = {}
    pages = {page["pdf"] for page in data["source"]["pages"]}
    fields = {"measure", "staff", "midi", "offset", "divisions", "finger", "sourcePage"}
    for mark in data["markings"]:
        if set(mark) != fields or any(type(value) is not int for value in mark.values()):
            raise ValueError(f"Invalid marking fields: {mark}")
        if not (mark["measure"] >= 0 and 1 <= mark["staff"] <= 4 and
                0 <= mark["midi"] <= 127 and mark["offset"] >= 0 and
                mark["divisions"] > 0 and 1 <= mark["finger"] <= 5 and
                mark["sourcePage"] in pages):
            raise ValueError(f"Invalid marking values: {mark}")
        key = marking_key(mark)
        if key in markings:
            raise ValueError(f"Duplicate marking: {mark}")
        markings[key] = mark

    document = ET.fromstring(original)
    parts = document.findall("part")
    if document.tag != "score-partwise" or len(parts) != 1:
        raise ValueError("Expected the checked single-part score")
    segments = list(NOTE.finditer(original))
    if len(segments) != len(document.findall("./part/measure/note")):
        raise ValueError("Cannot align note elements with original XML")

    divisions = 1
    ordinal = 0
    found = set()
    changes = []
    for measure in parts[0].findall("measure"):
        cursor = Fraction(0)
        last_start = Fraction(0)
        for element in measure:
            if element.tag == "attributes":
                divisions = int(element.findtext("divisions", str(divisions)))
            elif element.tag in ("backup", "forward"):
                amount = Fraction(int(element.findtext("duration", "0")), divisions)
                cursor += amount if element.tag == "forward" else -amount
            elif element.tag == "note":
                segment = segments[ordinal]
                ordinal += 1
                chord = element.find("chord") is not None
                start = last_start if chord else cursor
                if not chord:
                    last_start = start
                    if element.find("grace") is None:
                        cursor += Fraction(int(element.findtext("duration", "0")), divisions)
                pitch = element.find("pitch")
                if pitch is None:
                    continue
                midi = (int(pitch.findtext("octave")) + 1) * 12 + STEPS[pitch.findtext("step")] + int(pitch.findtext("alter", "0"))
                key = (int(measure.get("number")), int(element.findtext("staff", "1")), midi, start)
                mark = markings.get(key)
                if mark is None:
                    continue
                found.add(key)
                body = segment.group()
                insertion = f'<fingering>{mark["finger"]}</fingering>'
                if "</technical>" in body:
                    position = body.index("</technical>")
                elif "</notations>" in body:
                    position = body.index("</notations>")
                    insertion = f"<technical>{insertion}</technical>"
                else:
                    position = body.index("</note>")
                    insertion = f"<notations><technical>{insertion}</technical></notations>"
                changes.append((segment.start() + position, insertion))

    if found != markings.keys():
        missing = [markings[key] for key in markings.keys() - found]
        raise ValueError(f"Markings do not match any source note: {missing}")
    annotated_notes = len(changes)
    credit = source_field(data)
    identification = re.search(r"<identification>.*?</identification>", original, re.S)
    if not identification:
        raise ValueError("Missing score identification")
    if "</miscellaneous>" in identification.group():
        position = identification.start() + identification.group().index("</miscellaneous>")
    else:
        position = identification.end() - len("</identification>")
        credit = f"<miscellaneous>{credit}</miscellaneous>"
    changes.append((position, credit))
    result = original
    for position, insertion in sorted(changes, reverse=True):
        result = result[:position] + insertion + result[position:]
    if unannotate(result) != original:
        raise ValueError("Annotation changed source XML")
    return result, annotated_notes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify the committed archive without writing")
    args = parser.parse_args()
    data = json.loads(DATA.read_text())
    with ZipFile(SCORE) as archive:
        members = [(info, archive.read(info)) for info in archive.infolist()]
        comment = archive.comment
    container = ET.fromstring(dict((info.filename, body) for info, body in members)["META-INF/container.xml"])
    rootfile = next(element for element in container.iter() if element.tag.split("}")[-1] == "rootfile")
    path = rootfile.get("full-path")
    xml = next(body.decode("utf-8") for info, body in members if info.filename == path)
    annotated, count = annotate(xml, data)
    if args.check and annotated != xml:
        raise ValueError("Archive annotations differ from the data; run python3 scripts/annotate-score.py")
    if not args.check and annotated != xml:
        with tempfile.NamedTemporaryFile(dir=SCORE.parent, suffix=".mxl", delete=False) as temporary:
            temporary_path = Path(temporary.name)
        try:
            with ZipFile(temporary_path, "w") as archive:
                archive.comment = comment
                for info, body in members:
                    archive.writestr(info, annotated.encode("utf-8") if info.filename == path else body)
            temporary_path.chmod(SCORE.stat().st_mode)
            temporary_path.replace(SCORE)
        finally:
            temporary_path.unlink(missing_ok=True)
    print(f'{len(data["markings"])} printed markings; {count} MusicXML notes; cleaned source bytes unchanged')


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, StopIteration, ET.ParseError) as error:
        raise SystemExit(str(error)) from error
