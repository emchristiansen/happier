import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { useDesktopWindowDragMouseProps } from '@/components/navigation/desktopWindowChrome/DesktopWindowDragRegion';
import { desktopSidebarChromeStyles } from './desktopSidebarChromeStyles';

type DesktopWindowControlsSlotProps = Readonly<{
    children?: React.ReactNode;
    slotStyle?: StyleProp<ViewStyle>;
    contentStyle?: StyleProp<ViewStyle>;
    dragRegionStyle?: StyleProp<ViewStyle>;
    enableDragging?: boolean;
}>;

export const DesktopWindowControlsSlot = React.memo((props: DesktopWindowControlsSlotProps) => {
    const styles = desktopSidebarChromeStyles;
    const dragProps = useDesktopWindowDragMouseProps(props.enableDragging === true);

    return (
        <View testID="desktop-window-controls-slot" style={[styles.windowControlsSlot, props.slotStyle]}>
            <View
                {...dragProps}
                testID="desktop-window-drag-region"
                style={[styles.windowDragRegion, props.dragRegionStyle]}
            />
            <View style={[styles.windowControlsContent, props.contentStyle]}>
                {props.children}
            </View>
        </View>
    );
});
