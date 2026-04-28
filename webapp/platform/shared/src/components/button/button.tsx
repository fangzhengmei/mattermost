// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import React from 'react';

import {buttonClassNames, type ButtonEmphasis, type ButtonSize, type ButtonVariant} from './button_classes';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    children: React.ReactNode;

    emphasis?: ButtonEmphasis;
    size?: ButtonSize;
    variant?: ButtonVariant;

    // width?: 'full' | number; // TODO
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({
    children,
    className,

    emphasis,
    size,
    variant,

    // width = 'auto',

    ...otherProps
}, ref) => {
    return (
        <button
            ref={ref}
            className={buttonClassNames({emphasis, size, variant}, /*{
                // 'btn-full': width === 'full',
            },*/ className)}
            {...otherProps}
        >
            {children}
        </button>
    );
});
Button.displayName = 'Button';
