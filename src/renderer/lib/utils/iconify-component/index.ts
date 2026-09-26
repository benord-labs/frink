import { Icon, type IconifyIcon, type IconProps } from '@iconify/react/offline';
import { createElement, type ReactElement } from 'react';

type IconComponent = (props: Omit<IconProps, 'icon'>) => ReactElement;

const iconComponents = new Map<IconifyIcon, IconComponent>();

/** Stable component per Iconify icon, for surfaces that pass icons around as components. */
export function iconifyComponent(icon: IconifyIcon): IconComponent {
  let component = iconComponents.get(icon);
  if (!component) {
    component = (props) => createElement(Icon, { 'aria-hidden': true, ...props, icon });
    iconComponents.set(icon, component);
  }
  return component;
}
