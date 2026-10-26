#!/usr/bin/env python3
"""Create an unreviewed local reference-image/source-zone bundle for FireGuard."""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import cv2
import numpy as np

from edge.scene_continuity import write_reference_bundle


def _rect(value):
    try:
        result = [float(part.strip()) for part in value.split(',')]
    except ValueError:
        raise argparse.ArgumentTypeError('crop must be x,y,width,height') from None
    if len(result) != 4:
        raise argparse.ArgumentTypeError('crop must be x,y,width,height')
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True, type=Path, help='the exact camera JPEG used for review')
    parser.add_argument('--camera', required=True)
    parser.add_argument('--output', required=True, type=Path, help='new bundle directory; must not exist')
    parser.add_argument('--zone-id', required=True)
    parser.add_argument('--source-type', required=True, choices=('candle', 'stationary_burner'))
    parser.add_argument('--context-revision', type=int, required=True)
    parser.add_argument('--geometry-revision', type=int, required=True)
    parser.add_argument('--crop-rect', type=_rect, default=[0, 0, 1, 1],
                        help='normalized camera crop x,y,width,height; default is the full frame')
    args = parser.parse_args(argv)
    try:
        jpeg = args.image.read_bytes()
    except OSError:
        parser.error('could not read reference JPEG')
    image = cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        parser.error('reference image must be a readable JPEG')
    height, width = image.shape[:2]
    window = f'FireGuard source zone: {args.zone_id} ({args.source_type})'
    try:
        roi = cv2.selectROI(window, image, fromCenter=False, showCrosshair=True)
    finally:
        cv2.destroyAllWindows()
    x, y, zone_width, zone_height = (int(value) for value in roi)
    if zone_width <= 0 or zone_height <= 0:
        parser.error('no source rectangle selected')
    zone = {'zone_id': args.zone_id, 'source_type': args.source_type,
            'bbox_normalized': [x / width, y / height,
                                (x + zone_width) / width, (y + zone_height) / height]}
    try:
        bundle = write_reference_bundle(jpeg, args.output, camera_id=args.camera,
            context_revision=args.context_revision, geometry_revision=args.geometry_revision,
            source_zones=[zone], crop_rect=args.crop_rect)
    except (OSError, ValueError) as error:
        parser.error(str(error))
    print(json.dumps({'bundle': str(args.output / 'reference-bundle.json'),
                      'reference_image_sha256': bundle['reference_image_sha256'],
                      'dimensions': bundle['dimensions'], 'source_zone': zone,
                      'status': 'draft_requires_operator_review'}, indent=2))
    print('Review the image and rectangle in person, then copy the manifest values into trusted CAMERA_CONTEXTS_JSON with reviewer, revisions, and a review expiry. This utility does not activate or approve the zone.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
