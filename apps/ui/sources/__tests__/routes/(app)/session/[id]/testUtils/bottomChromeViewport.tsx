import * as React from 'react';
import type { ViewStyle } from 'react-native';
import Yoga from 'yoga-layout';

import { useSessionCockpitBottomChromeHeightSetter } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';

export function PublishBottomChromeHeight(props: Readonly<{ height: number }>) {
    const setHeight = useSessionCockpitBottomChromeHeightSetter();
    React.useLayoutEffect(() => setHeight(props.height), [props.height, setHeight]);
    return null;
}

export function measureScreenContentBottom(frameStyle: ViewStyle, height: number): number {
    const frame = Yoga.Node.create();
    const content = Yoga.Node.create();
    try {
        frame.setWidth(390);
        frame.setHeight(height);
        frame.setPadding(Yoga.EDGE_BOTTOM, Number(frameStyle.paddingBottom ?? frameStyle.paddingVertical ?? frameStyle.padding ?? 0));
        frame.setPadding(Yoga.EDGE_TOP, Number(frameStyle.paddingTop ?? frameStyle.paddingVertical ?? frameStyle.padding ?? 0));
        content.setFlex(1);
        frame.insertChild(content, 0);
        frame.calculateLayout(undefined, undefined, Yoga.DIRECTION_LTR);
        return content.getComputedTop() + content.getComputedHeight();
    } finally {
        frame.freeRecursive();
    }
}
