import type { ReactNode } from 'react';
import { View } from 'react-native';
import type { LucideIcon } from 'lucide-react-native';
import { radius, useTheme } from '../../../ui/theme';

/** The 38pt leading square every row in this area uses, so glyphs line up with other tabs. */
export function Tile({ children }: { children: ReactNode }) {
  const t = useTheme();
  return (
    <View
      style={{
        width: 38,
        height: 38,
        borderRadius: radius.md,
        backgroundColor: t.fill,
        borderWidth: 1,
        borderColor: t.borderSubtle,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {children}
    </View>
  );
}

/** A monochrome icon in a tile, for rows that name a thing rather than a state. */
export function IconTile({ icon: Icon }: { icon: LucideIcon }) {
  const t = useTheme();
  return (
    <Tile>
      <Icon size={18} color={t.secondary} strokeWidth={1.9} />
    </Tile>
  );
}
