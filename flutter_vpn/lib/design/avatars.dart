import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

/// One of the Pleat characters a person can pick as their profile picture.
/// The art lives in assets/avatars (drawn by tool/avatars.py); the server
/// only keeps the id.
class PleatAvatar {
  const PleatAvatar(this.id, this.name, this.kind);
  final String id, name, kind;
}

/// Same ids, same order as AVATARS in worker/src/auth.js.
const pleatAvatars = [
  PleatAvatar('vesper', 'Vesper', 'Fox'),
  PleatAvatar('kite', 'Kite', 'Bird'),
  PleatAvatar('miso', 'Miso', 'Cat'),
  PleatAvatar('hoot', 'Hoot', 'Owl'),
  PleatAvatar('bruno', 'Bruno', 'Bear'),
  PleatAvatar('relay', 'Relay', 'Robot'),
  PleatAvatar('orbit', 'Orbit', 'Astronaut'),
  PleatAvatar('drift', 'Drift', 'Ghost'),
  PleatAvatar('hop', 'Hop', 'Rabbit'),
  PleatAvatar('nimbus', 'Nimbus', 'Cloud'),
  PleatAvatar('rex', 'Rex', 'Dino'),
  PleatAvatar('luna', 'Luna', 'Long hair'),
  PleatAvatar('mina', 'Mina', 'Bun'),
  PleatAvatar('kai', 'Kai', 'Short hair'),
];

PleatAvatar? avatarById(String? id) {
  for (final a in pleatAvatars) {
    if (a.id == id) return a;
  }
  return null;
}

/// The character itself, round, with its own background.
class AvatarArt extends StatelessWidget {
  const AvatarArt(this.avatar, {super.key, required this.size});
  final PleatAvatar avatar;
  final double size;

  @override
  Widget build(BuildContext context) => SvgPicture.asset(
    'assets/avatars/${avatar.id}.svg',
    width: size,
    height: size,
    semanticsLabel: avatar.name,
  );
}
