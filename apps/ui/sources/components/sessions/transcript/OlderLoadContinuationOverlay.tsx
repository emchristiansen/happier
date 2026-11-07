import * as React from 'react';
import { View } from 'react-native';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TRANSCRIPT_TOP_GUTTER_PX } from '@/components/sessions/transcript/_constants';
import { t } from '@/text';

/** Reader recovery stays outside list geometry, just like the older-load indicator. */
export const OlderLoadContinuationOverlay = React.memo(function OlderLoadContinuationOverlay(props: Readonly<{
    onContinue: () => void;
}>) {
    return (
        <View
            pointerEvents="box-none"
            style={{
                alignItems: 'center',
                left: 0,
                position: 'absolute',
                right: 0,
                top: TRANSCRIPT_TOP_GUTTER_PX,
                zIndex: 2,
            }}
        >
            <RoundButton
                testID="transcript-older-load-continue"
                size="normal"
                title={t('session.transcriptGap.earlierMessages')}
                accessibilityLabel={t('session.transcriptGap.earlierMessages')}
                onPress={props.onContinue}
            />
        </View>
    );
});
