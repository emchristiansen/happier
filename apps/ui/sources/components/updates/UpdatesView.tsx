import * as React from 'react';
import { View } from 'react-native';

import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useUpdatesContentModel } from '@/updates/useUpdatesContentModel';

import { UpdatesContent } from './UpdatesContent';

/** Settings › Updates: the full list, every row, in the grouped density. */
export const UpdatesView = React.memo(function UpdatesView() {
    const model = useUpdatesContentModel();
    const maxWidth = useLayoutMaxWidth();
    return (
        <ItemList style={{ paddingTop: 0 }} testID="updates-screen">
            <View style={{ width: '100%', maxWidth, alignSelf: 'center' }}>
                <UpdatesContent model={model} presentation="screen" />
            </View>
        </ItemList>
    );
});
